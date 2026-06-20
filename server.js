import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import Parser from 'rss-parser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const rssParser = new Parser({
  timeout: 8000,
  headers: { 'User-Agent': 'Finsight/1.0 RSS Reader' },
});

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// In-memory digest cache
let digestCache = null;

// ─── RSS Feed Sources ─────────────────────────────────────────────────────────

const RSS_FEEDS = [
  { name: 'CoinDesk',       url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'CoinTelegraph',  url: 'https://cointelegraph.com/rss' },
  { name: 'The Defiant',    url: 'https://thedefiant.io/feed' },
  { name: 'Bankless',       url: 'https://banklesshq.com/rss' },
  { name: 'Unchained',      url: 'https://unchainedcrypto.com/feed/' },
  { name: 'Federal Reserve',url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
];

// ─── Fetch Helpers ────────────────────────────────────────────────────────────

async function timedFetch(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ─── Data Fetchers ────────────────────────────────────────────────────────────

async function fetchRSS() {
  const results = await Promise.allSettled(
    RSS_FEEDS.map(async ({ name, url }) => {
      const feed = await rssParser.parseURL(url);
      return {
        source: name,
        items: feed.items.slice(0, 4).map(item => ({
          title: item.title?.trim() || 'Untitled',
          snippet: (item.contentSnippet || item.summary || '').slice(0, 250).trim(),
          date: item.isoDate || item.pubDate || '',
        })),
      };
    })
  );
  return results.filter(r => r.status === 'fulfilled').map(r => r.value);
}

async function fetchPrices() {
  const res = await timedFetch(
    'https://api.coingecko.com/api/v3/coins/markets' +
    '?vs_currency=usd&ids=bitcoin,ethereum,solana' +
    '&order=market_cap_desc&per_page=3&page=1' +
    '&sparkline=false&price_change_percentage=24h'
  );
  return res.json();
}

async function fetchDeFi() {
  const [protRes, chartsRes] = await Promise.all([
    timedFetch('https://api.llama.fi/protocols'),
    timedFetch('https://api.llama.fi/charts'),
  ]);

  const protocols = await protRes.json();
  const charts = await chartsRes.json();

  const topProtocols = [...protocols]
    .sort((a, b) => (b.tvl || 0) - (a.tvl || 0))
    .slice(0, 10)
    .map(p => ({
      name: p.name,
      tvl: p.tvl || 0,
      change1d: p.change_1d ?? null,
    }));

  const latest = charts[charts.length - 1];
  const prev = charts[charts.length - 2];
  const totalTvl = latest?.totalLiquidityUSD || null;
  const tvlChange24h =
    totalTvl && prev?.totalLiquidityUSD
      ? ((totalTvl - prev.totalLiquidityUSD) / prev.totalLiquidityUSD * 100).toFixed(2)
      : null;

  return { totalTvl, tvlChange24h, topProtocols };
}

async function fetchFearGreed() {
  const res = await timedFetch('https://api.alternative.me/fng/?limit=1');
  const { data } = await res.json();
  return { score: data[0].value, label: data[0].value_classification };
}

async function fetchMacro() {
  const key = process.env.FRED_API_KEY;
  if (!key) return null;

  const base = 'https://api.stlouisfed.org/fred/series/observations';
  const params = `&api_key=${key}&limit=2&sort_order=desc&file_type=json`;

  const series = [
    { id: 'FEDFUNDS', label: 'Fed Funds Rate' },
    { id: 'CPIAUCSL', label: 'CPI' },
    { id: 'UNRATE',   label: 'Unemployment Rate' },
  ];

  const results = await Promise.allSettled(
    series.map(({ id }) =>
      timedFetch(`${base}?series_id=${id}${params}`).then(r => r.json())
    )
  );

  const macro = {};
  series.forEach(({ label }, i) => {
    const r = results[i];
    if (r.status !== 'fulfilled' || !r.value.observations?.[0]) return;
    const [cur, prev] = r.value.observations;
    macro[label] = { value: cur.value, date: cur.date, prev: prev?.value };
  });
  return Object.keys(macro).length > 0 ? macro : null;
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────

function buildPrompt({ prices, fearGreed, defi, macro, news }) {
  const lines = ["Here is today's aggregated financial and crypto data:\n"];

  lines.push('### Crypto Prices (CoinGecko)');
  for (const c of prices) {
    const chg = c.price_change_percentage_24h?.toFixed(2) ?? 'N/A';
    const mcap = (c.market_cap / 1e9).toFixed(1);
    lines.push(
      `${c.name} (${c.symbol.toUpperCase()}): $${c.current_price.toLocaleString()} | 24h: ${chg}% | MCap: $${mcap}B`
    );
  }
  if (fearGreed) {
    lines.push(`Fear & Greed Index: ${fearGreed.score}/100 — ${fearGreed.label}`);
  }

  if (defi) {
    lines.push('\n### DeFi TVL (DeFi Llama)');
    if (defi.totalTvl) {
      const tvl = (defi.totalTvl / 1e9).toFixed(1);
      lines.push(
        `Total DeFi TVL: $${tvl}B` +
        (defi.tvlChange24h ? ` (24h change: ${defi.tvlChange24h}%)` : '')
      );
    }
    lines.push('Top 10 Protocols by TVL:');
    defi.topProtocols.forEach((p, i) => {
      const tvl = (p.tvl / 1e9).toFixed(2);
      const chg = p.change1d !== null
        ? ` (${p.change1d >= 0 ? '+' : ''}${Number(p.change1d).toFixed(1)}% 24h)`
        : '';
      lines.push(`  ${i + 1}. ${p.name}: $${tvl}B${chg}`);
    });
  }

  if (macro && Object.keys(macro).length > 0) {
    lines.push('\n### Macro Indicators (FRED)');
    for (const [label, d] of Object.entries(macro)) {
      lines.push(
        `${label}: ${d.value}% (${d.date})` +
        (d.prev ? ` | Previous: ${d.prev}%` : '')
      );
    }
  }

  if (news.length > 0) {
    lines.push('\n### Latest Headlines');
    for (const feed of news) {
      if (!feed.items.length) continue;
      lines.push(`\n**${feed.source}:**`);
      for (const item of feed.items) {
        const snippet = item.snippet ? ` — ${item.snippet}` : '';
        lines.push(`- ${item.title}${snippet}`);
      }
    }
  }

  lines.push(`
---
Using the data above, write a morning digest with EXACTLY these five sections (use these exact headers):

## 1. Market Snapshot
Summarize BTC, ETH, SOL prices, total DeFi TVL, and the Fear & Greed reading. Add 1–2 sentences of context on what is driving movement today.

## 2. Macro Pulse
Interpret the Fed funds rate, CPI, and unemployment data and explain what they signal for risk assets and crypto. If FRED data is unavailable, use macro context from the headlines.

## 3. DeFi Alpha
Highlight notable TVL shifts, protocol-level moves, and yield dynamics worth knowing today. Pull specific numbers from the top-10 protocol data.

## 4. Top Stories
Exactly 5 bullet points summarizing the most important headlines. Prioritize stories about: ZK proofs, on-chain AI, DeFi infrastructure, Solana, institutional crypto adoption, or macro policy.

## 5. One Thing to Learn Today
Pick one concept that surfaced in today's news and explain it in exactly 3 sentences: what it is, how it works, and why it matters right now.`);

  return lines.join('\n');
}

// ─── Digest Builder ───────────────────────────────────────────────────────────

async function buildDigest() {
  console.log('[Finsight] Fetching all data sources in parallel...');

  const [pricesResult, defiResult, fearGreedResult, macroResult, newsResult] =
    await Promise.allSettled([
      fetchPrices(),
      fetchDeFi(),
      fetchFearGreed(),
      fetchMacro(),
      fetchRSS(),
    ]);

  const logFailure = (name, result) => {
    if (result.status === 'rejected') {
      console.warn(`[Finsight] ${name} failed: ${result.reason?.message}`);
    }
  };
  logFailure('CoinGecko',  pricesResult);
  logFailure('DeFi Llama', defiResult);
  logFailure('Fear/Greed', fearGreedResult);
  logFailure('FRED',       macroResult);
  logFailure('RSS',        newsResult);

  const data = {
    prices:    pricesResult.status    === 'fulfilled' ? pricesResult.value    : [],
    defi:      defiResult.status      === 'fulfilled' ? defiResult.value      : null,
    fearGreed: fearGreedResult.status === 'fulfilled' ? fearGreedResult.value : null,
    macro:     macroResult.status     === 'fulfilled' ? macroResult.value     : null,
    news:      newsResult.status      === 'fulfilled' ? newsResult.value      : [],
  };

  console.log('[Finsight] Data fetched. Calling Claude...');

  const message = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 4096,
    system:
      'You are a sharp, data-driven financial and crypto analyst writing morning briefings for sophisticated investors. ' +
      'Be specific — cite exact numbers and percentages from the data. ' +
      'Keep each section tight and actionable. ' +
      'Do not add preamble or closing remarks outside the five requested sections.',
    messages: [{ role: 'user', content: buildPrompt(data) }],
  });

  const digest = message.content[0].text;
  console.log('[Finsight] Digest ready.');

  digestCache = {
    digest,
    prices:    data.prices,
    fearGreed: data.fearGreed,
    timestamp: new Date().toISOString(),
  };

  return digestCache;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/digest', (req, res) => {
  if (digestCache) return res.json(digestCache);
  res.status(404).json({ error: 'No digest cached yet — click Refresh to generate your first one.' });
});

app.post('/api/refresh', async (req, res) => {
  try {
    const result = await buildDigest();
    res.json(result);
  } catch (err) {
    console.error('[Finsight] Refresh error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🗞  Finsight running at http://localhost:${PORT}\n`);
  buildDigest().catch(err =>
    console.error('[Finsight] Initial digest build failed:', err.message)
  );
});

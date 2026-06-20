# Finsight

A personal daily market digest dashboard that aggregates crypto prices, DeFi TVL, macroeconomic indicators, and news headlines from six RSS feeds, then synthesizes everything into a structured morning brief using Claude AI. Runs locally at `http://localhost:3000`.

---

## What it does

On startup — and on demand via a button — Finsight fires requests to every data source in parallel, feeds the raw numbers directly into a Claude prompt, and renders the AI-generated brief in a dark-theme card dashboard. The digest is cached in memory so page reloads are instant; Claude is only called when you explicitly regenerate.

The digest always has five sections:

| Section | What it covers |
|---|---|
| **Market Snapshot** | BTC, ETH, SOL prices + 24h change + market cap; total DeFi TVL; Fear & Greed reading; 1–2 sentences of context on what's moving |
| **Macro Pulse** | Fed funds rate, CPI, and unemployment data interpreted for risk assets and crypto |
| **DeFi Alpha** | Notable TVL shifts, protocol-level moves, and yield dynamics pulled from the top-10 protocol list |
| **Top Stories** | 5 bullet summaries from RSS feeds, prioritizing ZK proofs, on-chain AI, DeFi infrastructure, Solana, institutional crypto, and macro policy |
| **One Thing to Learn Today** | A 3-sentence explainer on a concept surfaced in today's news |

---

## Features

- **Fully parallel data fetching** — all five sources fire simultaneously via `Promise.allSettled`; any single source failing silently degrades without blocking the rest
- **12-second per-source timeouts** via `AbortController` so a slow feed never hangs the whole refresh
- **In-memory digest cache** — `GET /api/digest` returns instantly after the first build; Claude is never called on a page reload
- **Live price ticker** — coin logo, symbol, current price, and color-coded 24h % badge for BTC/ETH/SOL; Fear & Greed chip with score-based color scale
- **Dark dashboard UI** — sticky header, responsive 2-column card grid (collapses to 1 column on mobile), markdown rendered inside each card via `marked.js`
- **Loading state** — button spinner + full-width banner while Claude is synthesizing; button is disabled to prevent double-submits
- **Graceful empty and error states** — clear messaging when no digest exists yet or when a refresh fails

---

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js ≥ 18 (native `fetch` and ESM required) |
| Web server | Express 4 |
| AI synthesis | Anthropic Node SDK — `claude-opus-4-8`, 4096 output tokens |
| RSS parsing | `rss-parser` |
| Environment | `dotenv` |
| Frontend | Vanilla HTML, CSS, JavaScript — zero build step |
| Markdown rendering | `marked.js` v9 via CDN |

---

## Data sources

All APIs are free. No account is required for CoinGecko, DeFi Llama, or Fear & Greed.

| Source | What is fetched | Key required |
|---|---|---|
| [CoinGecko](https://www.coingecko.com/en/api) | BTC, ETH, SOL — price, 24h change, market cap | No |
| [DeFi Llama](https://defillama.com/docs/api) | Total DeFi TVL + 24h change; top-10 protocols by TVL + 24h change | No |
| [alternative.me Fear & Greed](https://alternative.me/crypto/fear-and-greed-index/) | Current score (0–100) and label | No |
| [Federal Reserve FRED](https://fred.stlouisfed.org/docs/api/fred/) | Fed funds rate (`FEDFUNDS`), CPI (`CPIAUCSL`), unemployment rate (`UNRATE`) — latest two observations for each | **Yes** — free |
| **RSS — CoinDesk** | Latest 4 headlines + snippets | No |
| **RSS — CoinTelegraph** | Latest 4 headlines + snippets | No |
| **RSS — The Defiant** | Latest 4 headlines + snippets | No |
| **RSS — Bankless** | Latest 4 headlines + snippets | No |
| **RSS — Unchained** | Latest 4 headlines + snippets | No |
| **RSS — Federal Reserve** | Latest 4 press releases | No |

If the FRED key is omitted, the Macro Pulse section is generated from headline context instead.

---

## Project structure

```
Finsight-/
├── server.js          # Express server — data fetching, prompt building, Claude call
├── public/
│   └── index.html     # Dashboard — ticker, cards, vanilla JS, all CSS inline
├── package.json
├── .env               # Your API keys (never commit this)
└── .env.example       # Safe template
```

**API endpoints exposed by `server.js`:**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/digest` | Returns the in-memory cached digest (404 if none built yet) |
| `POST` | `/api/refresh` | Fetches all sources, calls Claude, updates the cache, returns the new digest |

---

## Setup

### 1. Prerequisites

- Node.js 18 or later (`node --version` to check)
- An [Anthropic API key](https://console.anthropic.com)
- A [FRED API key](https://fred.stlouisfed.org/docs/api/api_key.html) (free, instant registration)

### 2. Clone and install

```bash
git clone <your-repo-url>
cd Finsight-
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in both keys:

```env
ANTHROPIC_API_KEY=sk-ant-...
FRED_API_KEY=your_fred_api_key_here
```

### 4. Start the server

```bash
npm start
```

Or, with auto-restart on file changes during development:

```bash
npm run dev
```

Open **[http://localhost:3000](http://localhost:3000)**.

The server fetches all data sources and calls Claude immediately on startup. The digest will be ready in roughly 30–45 seconds — the loading banner in the UI shows progress. Subsequent page loads serve the cached digest instantly.

### 5. Regenerate

Click **Regenerate Digest** in the header at any time. The button is disabled and shows a spinner while the refresh is running. Each regeneration makes one call to `claude-opus-4-8`.

---

## Notes

- **Cost** — each digest generation makes one Claude API call with approximately 2,000–3,000 input tokens and up to 4,096 output tokens. At `claude-opus-4-8` pricing that is roughly $0.08–$0.12 per generation.
- **Rate limits** — CoinGecko's free tier allows 5–15 requests per minute. Since Finsight only calls it on-demand this is not a concern under normal use.
- **Cache persistence** — the digest lives in process memory only. Restarting the server clears it, and the first request after restart triggers a new build automatically.
- **FRED data lag** — FRED publishes monthly releases on a schedule. The values returned are always the most recent available publication, which may be 3–6 weeks behind the current date.

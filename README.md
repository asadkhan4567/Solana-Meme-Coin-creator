# Solana Meme Coin Creator Agent

An autonomous bot that finds what's trending, invents a meme coin for it, makes the logo, and launches it on [pump.fun](https://pump.fun). It runs on its own, keeps itself within limits you set, and recovers from errors by itself.

Built on the official [pump-fun-skills](https://github.com/pump-fun/pump-fun-skills) `create-coin` and `coin-fees` APIs.

## What one cycle does

```
 1. Learn       check coins launched 1h / 24h ago -> success or flop -> adjust strategy
 2. Harvest     collect creator fees from all your coins (only when worth the tx fee)
 3. Gates       paused? outside launch hours? daily launch / spend limit hit? -> stop here
 4. Scan        DexScreener (+ X if you have a token) -> score trending words -> pick ONE theme
 5. Create      Claude AND ChatGPT each invent a coin (name, ticker, description)
                -> "don't copy" check: ticker/name already on pump.fun or a DEX? -> AI picks a new one
                -> both AIs judge both ideas -> best one wins
 6. Logo        DALL-E AND Flux each draw a logo -> AIs judge the images -> best one wins
 7. Upload      logo + metadata JSON -> IPFS (Pinata) -> metadata URI
 8. Size        stronger trend = bigger initial buy (between your min and max)
 9. Launch      check wallet balance -> pump.fun builds tx -> verify -> sign -> simulate -> send
10. Announce    post the coin (logo, link, contract address) to your Telegram channel and X
11. Report      save everything to out/<run>/, show it on the dashboard, alert n8n -> Telegram
```

With `DRY_RUN=true` (the default) step 9 stops after the simulation: **no SOL is spent**.

## Strategies built in

| Strategy | What it does | Setting |
| --- | --- | --- |
| Trend threshold | Only launches on strong trends, so weak ideas don't waste SOL | `MIN_TREND_SCORE` |
| Cross-source boost | A theme seen on-chain (DexScreener volume) **and** on X scores higher | automatic |
| AI contests | Claude vs ChatGPT for the concept, DALL-E vs Flux for the logo; both AIs judge | set both keys |
| Position sizing | Initial buy grows with trend strength, capped by daily budget | `INITIAL_BUY_MIN/MAX_SOL` |
| Peak hours | Launch only when most traders are online | `LAUNCH_HOURS_UTC` |
| Fresh themes | Never repeats a theme it used recently | `THEME_COOLDOWN_HOURS` |
| Creator-fee harvesting | pump.fun pays you a share of every trade on your coins; collected automatically | `FEE_COLLECT_*` |
| Learning loop | Tracks each coin at 1h/24h; trend sources that produce winners get picked more | `SUCCESS_MCAP_USD` |
| Circuit breaker | After N flops in a row, pauses launching so a bad market can't drain the wallet | `LOSS_STREAK_PAUSE`, `PAUSE_HOURS` |
| Name safety | Blocks celebrity, brand and famous-ticker names (these get flagged as scams) | `BLOCKED_TERMS` |
| Don't copy | Skips any ticker/name already used on pump.fun or a Solana DEX; the AI picks a new one | `TICKER_CHECK_*` |
| Auto-posting | Announces each live launch with its logo on Telegram and X to bring in buyers | `TELEGRAM_*`, `X_*` |

**What it does not do:** it never auto-sells your coins into buyers (that is a pump-and-dump). Your initial-buy tokens stay in your wallet; you decide if and when to sell.

**Be realistic:** most new pump.fun coins never take off. Each launch costs roughly the initial buy plus ~0.02-0.03 SOL in fees/rent. Start with small limits, watch the results for a week, then adjust.

## Self-healing

- Every network call retries with backoff; Solana RPC switches to a backup URL automatically.
- If one AI or image service fails, the other one is used.
- If a transaction expires before it lands, it is rebuilt with a fresh blockhash (it can never create two coins).
- A failing cycle never crashes the bot; the scheduler waits longer after each failure (up to 6h), alerts you, and alerts again when it recovers.
- State is written atomically; a corrupt state file is set aside and the bot starts clean.
- In Docker/Railway the process restarts automatically if it ever dies.

## Safety checks before any SOL moves

1. Wallet must hold `initial buy + LAUNCH_COST_BUFFER_SOL + MIN_WALLET_RESERVE_SOL`, otherwise it stops with a clear "Insufficient funds" alert.
2. It only signs a transaction whose fee payer is **your** wallet.
3. It simulates the transaction first and stops if the simulation fails.
4. Your private key is never logged.

## Setup

1. **Wallet:** in Phantom create a *new* account just for the bot, send it a small amount of SOL, then export its private key (Settings -> Manage Accounts -> Show Private Key).
2. **Keys:** get an RPC URL (Helius/QuickNode), OpenAI key, Anthropic key, fal.ai key (Flux), Pinata JWT.
3. **Configure:** `cp .env.example .env` and fill it in. Keep `DRY_RUN=true` for now.
4. **Install & test:**
   ```bash
   npm install
   npm test          # 56 tests, no keys needed
   npm run once      # one full dry-run cycle; look in out/<run>/ for the logos + summary
   ```
5. **Go live** when the dry runs look good: set `DRY_RUN=false`.

## Deploy (recommended: Railway, ~$5/month)

1. Railway -> New Project -> Deploy from GitHub repo -> this repo (it uses `Dockerfile` + `railway.json`).
2. Add all `.env` values as Railway **Variables**.
3. Add a **Volume** mounted at `/app/data` (keeps launch history across restarts).
4. Open `https://<your-app>.up.railway.app/health` to check it.

## Dashboard

Open `https://<your-app>/dashboard`. The browser asks for a login: type any username and your
`AGENT_API_TOKEN` as the password. It shows wallet balance, coins launched, SOL spent, creator fees
earned, win rate, which AI wins the idea and logo contests (and how often its coins succeed), and
every launch with its result, market cap, fees and links. It refreshes every minute.

## Auto-posting

Each **live** launch is posted to every channel you configure; dry runs only write
`out/<run>/posts-preview.txt` so you can check the wording first. Posts contain the name, ticker,
the AI's one-liner, the pump.fun link, the contract address and `POST_DISCLAIMER`, and never
promise gains (X and Telegram ban accounts for that). A failed post never fails a launch; it shows
as "failed" on the dashboard.

- **Telegram:** create a bot with @BotFather, add it as an admin of your channel, set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHANNEL_ID`.
- **X:** needs an X developer app with **Read and write** permission (posting needs at least the free tier; check X's current limits). Set the four `X_*` keys. If the image upload is refused the post goes out as text.

## n8n (scheduler + Telegram alerts)

The bot schedules itself (`CYCLE_INTERVAL_MIN`). n8n is optional but handy:

1. Import `n8n/meme-agent-workflow.json` into n8n.
2. Replace `{{ $vars.AGENT_URL }}`, `{{ $vars.AGENT_API_TOKEN }}` and `{{ $vars.TELEGRAM_CHAT_ID }}` with your values (n8n Variables need a paid plan; typing the values in directly works too) and connect your Telegram credential.
3. Put the n8n webhook URL (`.../webhook/meme-agent-alerts`) in `NOTIFY_WEBHOOK_URL`.
4. If n8n triggers the runs, set `CYCLE_INTERVAL_MIN=0` so the bot doesn't also run on its own timer.

## Control API

| Route | Auth | What |
| --- | --- | --- |
| `GET /health` | none | status, wallet balance, last run, failures, pause |
| `POST /run` | Bearer `AGENT_API_TOKEN` | run one cycle now |
| `POST /collect-fees` | Bearer | harvest creator fees now |
| `GET /launches` | Bearer | last 50 launches |
| `GET /dashboard` | Basic (password = token) | the dashboard page |
| `GET /api/summary` | Bearer or Basic | the dashboard's data as JSON |

## Project layout

```
src/
  index.ts              entry: scheduler (backoff + alerts), control API, --once / --collect-fees
  agent.ts              one cycle, step by step
  config.ts             all settings from .env, validated
  trendScanner.ts       DexScreener + X -> scored themes -> pickTrend (learning + cooldown)
  creativeDirector.ts   Claude vs GPT concepts, DALL-E vs Flux logos, AI judge panel
  metadataUploader.ts   Pinata IPFS upload -> metadata URI
  coinDeployer.ts       pump.fun create-coin API -> verify -> sign -> simulate -> send/Jito -> confirm
  guards.ts             name filter, launch hours, daily caps, position sizing, funds needed
  tickerCheck.ts        "don't copy": pump.fun + DexScreener search for the ticker/name
  promoter.ts           Telegram + X launch posts (lib/oauth1.ts signs X requests)
  dashboard.ts          dashboard numbers + the self-contained HTML page
  strategies/
    feeHarvester.ts     creator-fee collection
    performanceTracker.ts  1h/24h outcomes, source stats, circuit breaker
  lib/                  llm, imageGen, rpc failover, retry, wallet, jito
  store.ts, notify.ts, logger.ts
tests/                  vitest, all offline with fakes
n8n/                    importable n8n workflow
```

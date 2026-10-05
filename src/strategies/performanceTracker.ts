import type { Config } from "../config.js";
import { log } from "../logger.js";
import { notify } from "../notify.js";
import { httpJson } from "../lib/retry.js";
import type { LaunchRecord, Store } from "../store.js";

interface CoinV2 {
  usd_market_cap?: number;
  complete?: boolean;
  reply_count?: number;
}

const HOUR = 3_600_000;

/**
 * Strategy: learn from results.
 * - Snapshots each live coin at ~1h and ~24h (market cap, graduated?, replies).
 * - At 24h labels it success/dud and updates per-source stats, which the trend scanner uses to
 *   weight future picks (sources that produce winners get chosen more).
 * - Circuit breaker: LOSS_STREAK_PAUSE duds in a row pauses launching for PAUSE_HOURS,
 *   so a bad market can't drain the wallet.
 */
export async function trackPerformance(
  cfg: Pick<Config, "PUMP_COINS_API" | "SUCCESS_MCAP_USD" | "LOSS_STREAK_PAUSE" | "PAUSE_HOURS" | "NOTIFY_WEBHOOK_URL">,
  store: Store,
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  let updated = 0;
  for (const l of store.liveLaunches()) {
    if (l.outcome !== "pending") continue;
    const age = now.getTime() - Date.parse(l.createdAt);
    const wantSnapshot = (age >= HOUR && l.snapshots.length === 0) || (age >= 24 * HOUR && l.snapshots.length < 2);
    if (!wantSnapshot) continue;
    try {
      const coin = await httpJson<CoinV2>(`${cfg.PUMP_COINS_API.replace(/\/+$/, "")}/coins-v2/${l.mint}`, {}, { fetchImpl, retries: 2, label: "pump coins-v2" });
      l.snapshots.push({
        at: now.toISOString(),
        usdMarketCap: coin?.usd_market_cap ?? null,
        complete: Boolean(coin?.complete),
        replyCount: coin?.reply_count ?? null,
      });
      if (age >= 24 * HOUR) settleOutcome(cfg, store, l);
      updated++;
    } catch (err) {
      log.warn("performance snapshot failed", { mint: l.mint, error: String(err) });
    }
  }
  if (updated) {
    store.save();
    await applyCircuitBreaker(cfg, store, now);
  }
  return updated;
}

function settleOutcome(cfg: Pick<Config, "SUCCESS_MCAP_USD" | "NOTIFY_WEBHOOK_URL">, store: Store, l: LaunchRecord): void {
  const last = l.snapshots.at(-1);
  const success = Boolean(last && (last.complete || (last.usdMarketCap ?? 0) >= cfg.SUCCESS_MCAP_USD));
  l.outcome = success ? "success" : "dud";
  for (const s of l.sources) {
    const st = (store.state.sourceStats[s] ??= { launches: 0, successes: 0 });
    st.launches++;
    if (success) st.successes++;
  }
  log.info("launch outcome", { ticker: l.ticker, outcome: l.outcome, usdMarketCap: last?.usdMarketCap });
  void notify(cfg, "outcome", { ticker: l.ticker, mint: l.mint, outcome: l.outcome, usdMarketCap: last?.usdMarketCap });
}

export async function applyCircuitBreaker(
  cfg: Pick<Config, "LOSS_STREAK_PAUSE" | "PAUSE_HOURS" | "NOTIFY_WEBHOOK_URL">,
  store: Store,
  now: Date,
): Promise<boolean> {
  if (cfg.LOSS_STREAK_PAUSE <= 0) return false;
  const settled = store.liveLaunches().filter((l) => l.outcome !== "pending");
  const recent = settled.slice(-cfg.LOSS_STREAK_PAUSE);
  if (recent.length < cfg.LOSS_STREAK_PAUSE || recent.some((l) => l.outcome === "success")) return false;
  const lastSettled = recent.at(-1)!;
  // Only trip once per streak: skip if we already paused after this launch settled.
  if (store.state.pausedUntil && Date.parse(store.state.pausedUntil) > Date.parse(lastSettled.createdAt)) return false;
  store.state.pausedUntil = new Date(now.getTime() + cfg.PAUSE_HOURS * HOUR).toISOString();
  store.save();
  log.warn("circuit breaker: pausing launches", { pausedUntil: store.state.pausedUntil, streak: recent.length });
  await notify(cfg, "paused", { pausedUntil: store.state.pausedUntil, reason: `${recent.length} duds in a row` });
  return true;
}

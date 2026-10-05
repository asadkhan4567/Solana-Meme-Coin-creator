import { solToLamports, type Config } from "./config.js";
import type { AgentState } from "./store.js";

/**
 * Names that would impersonate real people, companies or famous tickers. Coins like that get
 * flagged on pump.fun, attract takedowns, and are the classic scam pattern - we never launch them.
 * Extend with BLOCKED_TERMS in .env.
 */
export const DEFAULT_BLOCKED_TERMS = [
  "trump", "melania", "barron", "biden", "harris", "obama", "elon", "musk", "bezos", "zuckerberg",
  "zuck", "saylor", "cz", "binance", "coinbase", "kraken", "tesla", "spacex", "apple", "google",
  "microsoft", "amazon", "nvidia", "openai", "chatgpt", "anthropic", "claude", "meta", "nike",
  "disney", "pixar", "marvel", "pokemon", "pikachu", "nintendo", "mickey", "official", "airdrop",
  "giveaway", "presale", "rug", "scam", "pepe", "doge", "shib", "bonk", "wif", "popcat", "solana",
  "usdc", "usdt", "tether", "bitcoin", "btc", "eth", "ethereum", "sol",
];

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export function checkNameAllowed(name: string, ticker: string, extra: string[] = []): { ok: boolean; reason?: string } {
  const blocked = new Set([...DEFAULT_BLOCKED_TERMS, ...extra.map((t) => t.toLowerCase())]);
  const tokens = new Set([...words(name), ...words(ticker)]);
  const compact = `${name}${ticker}`.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const term of blocked) {
    // whole-word match, or a longer term hidden inside a joined name ("ElonDog")
    if (tokens.has(term) || (term.length >= 4 && compact.includes(term))) {
      return { ok: false, reason: `contains blocked term "${term}"` };
    }
  }
  if (!/^[A-Z0-9]{2,10}$/.test(ticker)) return { ok: false, reason: "ticker must be 2-10 chars A-Z/0-9" };
  if (name.length < 2 || name.length > 32) return { ok: false, reason: "name must be 2-32 chars" };
  return { ok: true };
}

/** "13-23" -> launch only between 13:00 and 23:59 UTC; "22-4" wraps midnight; "" = any time. */
export function isWithinLaunchHours(now: Date, spec: string): boolean {
  if (!spec.trim()) return true;
  const ranges = spec.split(",").map((r) => r.trim().split("-").map(Number));
  const h = now.getUTCHours();
  return ranges.some(([a, b]) => {
    if (a === undefined || b === undefined || Number.isNaN(a) || Number.isNaN(b)) return false;
    return a <= b ? h >= a && h <= b : h >= a || h <= b;
  });
}

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function dailyStats(state: AgentState, now: Date): { launches: number; spentLamports: bigint } {
  const since = startOfUtcDay(now).getTime();
  const today = state.launches.filter((l) => !l.dryRun && l.mint && Date.parse(l.createdAt) >= since);
  return {
    launches: today.length,
    spentLamports: today.reduce((sum, l) => sum + BigInt(l.initialBuyLamports), 0n),
  };
}

export type LimitConfig = Pick<
  Config,
  | "MAX_LAUNCHES_PER_DAY"
  | "MAX_DAILY_SPEND_SOL"
  | "LAUNCH_HOURS_UTC"
  | "INITIAL_BUY_MIN_SOL"
  | "INITIAL_BUY_MAX_SOL"
  | "MIN_TREND_SCORE"
  | "MIN_WALLET_RESERVE_SOL"
  | "LAUNCH_COST_BUFFER_SOL"
>;

/** Pre-flight gate run before any paid API call. */
export function canLaunch(cfg: LimitConfig, state: AgentState, now: Date): { ok: boolean; reason?: string } {
  if (state.pausedUntil && Date.parse(state.pausedUntil) > now.getTime()) {
    return { ok: false, reason: `paused until ${state.pausedUntil} (loss-streak circuit breaker)` };
  }
  if (!isWithinLaunchHours(now, cfg.LAUNCH_HOURS_UTC)) {
    return { ok: false, reason: `outside launch hours ${cfg.LAUNCH_HOURS_UTC} UTC` };
  }
  const today = dailyStats(state, now);
  if (today.launches >= cfg.MAX_LAUNCHES_PER_DAY) {
    return { ok: false, reason: `daily launch limit reached (${today.launches}/${cfg.MAX_LAUNCHES_PER_DAY})` };
  }
  if (today.spentLamports + solToLamports(cfg.INITIAL_BUY_MIN_SOL) > solToLamports(cfg.MAX_DAILY_SPEND_SOL)) {
    return { ok: false, reason: "daily spend limit reached" };
  }
  return { ok: true };
}

/**
 * Position sizing: stronger trend -> bigger initial buy, linearly between MIN and MAX,
 * then capped by what is left of today's budget.
 */
export function sizeInitialBuy(score: number, cfg: LimitConfig, spentTodayLamports: bigint): bigint {
  const t = Math.min(1, Math.max(0, (score - cfg.MIN_TREND_SCORE) / (1 - cfg.MIN_TREND_SCORE)));
  const sol = cfg.INITIAL_BUY_MIN_SOL + (cfg.INITIAL_BUY_MAX_SOL - cfg.INITIAL_BUY_MIN_SOL) * t;
  const wanted = solToLamports(sol);
  const left = solToLamports(cfg.MAX_DAILY_SPEND_SOL) - spentTodayLamports;
  return wanted < left ? wanted : left;
}

/** Wallet must cover buy + rent/fees buffer + the reserve we never touch. */
export function requiredLamports(initialBuy: bigint, cfg: LimitConfig): bigint {
  return initialBuy + solToLamports(cfg.LAUNCH_COST_BUFFER_SOL) + solToLamports(cfg.MIN_WALLET_RESERVE_SOL);
}

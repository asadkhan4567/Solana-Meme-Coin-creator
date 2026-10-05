import type { Config } from "./config.js";
import { log } from "./logger.js";
import { httpJson } from "./lib/retry.js";

export type TickerStatus = "free" | "taken" | "unknown";

export interface TickerCheckResult {
  status: TickerStatus;
  /** Human-readable matches, e.g. "pump.fun: Frog King ($FROG)". */
  matches: string[];
}

interface PumpCoin {
  name?: string;
  symbol?: string;
  mint?: string;
}
interface DexSearch {
  pairs?: { chainId: string; baseToken: { name: string; symbol: string } }[];
}

const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();

function matchesOf(source: string, coins: { name?: string; symbol?: string }[], ticker: string, name: string): string[] {
  const t = norm(ticker);
  const n = norm(name);
  return coins
    .filter((c) => norm(c.symbol) === t || (n.length > 0 && norm(c.name) === n))
    .slice(0, 5)
    .map((c) => `${source}: ${c.name ?? "?"} ($${c.symbol ?? "?"})`);
}

/**
 * "Don't copy" check: is this ticker (or exact name) already used on pump.fun or on any Solana DEX pair?
 * Two independent sources; one being down is fine. If both are down the result is "unknown"
 * and the caller decides (default: treat as taken, i.e. skip - never launch blind).
 */
export async function checkTicker(
  cfg: Pick<Config, "PUMP_COINS_API" | "DEXSCREENER_API_URL">,
  ticker: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TickerCheckResult> {
  const pumpUrl = `${cfg.PUMP_COINS_API.replace(/\/+$/, "")}/coins/search?searchTerm=${encodeURIComponent(ticker)}&limit=50&offset=0&includeNsfw=true`;
  const dexUrl = `${cfg.DEXSCREENER_API_URL.replace(/\/+$/, "")}/latest/dex/search?q=${encodeURIComponent(ticker)}`;

  const [pump, dex] = await Promise.allSettled([
    httpJson<PumpCoin[] | { coins?: PumpCoin[] }>(pumpUrl, {}, { fetchImpl, retries: 1, label: "pump search" }),
    httpJson<DexSearch>(dexUrl, {}, { fetchImpl, retries: 1, label: "dex search" }),
  ]);

  const matches: string[] = [];
  let anyOk = false;
  if (pump.status === "fulfilled") {
    anyOk = true;
    const list = Array.isArray(pump.value) ? pump.value : (pump.value?.coins ?? []);
    matches.push(...matchesOf("pump.fun", list, ticker, name));
  } else {
    log.warn("pump.fun ticker search failed", { error: String(pump.reason) });
  }
  if (dex.status === "fulfilled") {
    anyOk = true;
    const sol = (dex.value?.pairs ?? []).filter((p) => p.chainId === "solana").map((p) => p.baseToken);
    matches.push(...matchesOf("dexscreener", sol, ticker, name));
  } else {
    log.warn("dexscreener ticker search failed", { error: String(dex.reason) });
  }

  if (matches.length) return { status: "taken", matches: [...new Set(matches)] };
  return { status: anyOk ? "free" : "unknown", matches: [] };
}

/**
 * Adapter for the creative director: returns a reason string when the concept must be
 * rejected, or null when it is free to use.
 */
export function tickerGuard(
  cfg: Pick<Config, "PUMP_COINS_API" | "DEXSCREENER_API_URL" | "TICKER_CHECK_FAIL_OPEN">,
  fetchImpl: typeof fetch = fetch,
): (ticker: string, name: string) => Promise<string | null> {
  return async (ticker, name) => {
    const r = await checkTicker(cfg, ticker, name, fetchImpl);
    if (r.status === "taken") return `ticker/name already used (${r.matches.join("; ")})`;
    if (r.status === "unknown" && !cfg.TICKER_CHECK_FAIL_OPEN) return "could not verify the ticker is unused (search APIs down)";
    return null;
  };
}

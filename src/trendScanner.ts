import type { Config } from "./config.js";
import { log } from "./logger.js";
import { httpJson } from "./lib/retry.js";
import type { AgentState } from "./store.js";

/** One piece of social/market evidence that mentions some words. */
export interface Signal {
  source: "dexscreener" | "x";
  label: string; // e.g. "$FROG vol1h=$120k" or "tweet 1.2k likes"
  text: string; // words to mine (name, symbol, description, tweet text)
  weight: number; // 0..~1.5, already log-scaled
}

export interface Trend {
  theme: string;
  score: number; // 0..1 after learning multiplier
  rawScore: number;
  sources: string[];
  related: string[];
  evidence: string[];
}

const STOPWORDS = new Set(
  (
    "the a an and or but of to in on at for with from by is are was were be been it its this that these those " +
    "you your we our they their i me my he she his her them just like get got have has had not no yes all any " +
    "will can now new more most very so too than then when what who how why where which there here about into " +
    "out up down over only also one two first next last official community community-driven join us via http https " +
    "www com twitter telegram website coin coins token tokens crypto memecoin memecoins meme memes solana sol pump " +
    "pumpfun fun dex chart buy sell hold holders moon lfg gm ca contract launch launched launching live today " +
    "time day people world best big little x2 x10 100x 1000x amp rt"
  ).split(/\s+/),
);

export function extractKeywords(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[#$]?[a-z][a-z0-9]{2,19}/g)) {
    const w = m[0].replace(/^[#$]/, "");
    if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    out.add(w);
  }
  return [...out];
}

/** Turn raw signals into ranked themes. Pure function (tested). */
export function scoreThemes(signals: Signal[], topN = 10): Trend[] {
  const agg = new Map<string, { raw: number; sources: Set<string>; evidence: string[]; co: Map<string, number> }>();
  for (const s of signals) {
    const kws = extractKeywords(s.text);
    for (const kw of kws) {
      const a = agg.get(kw) ?? { raw: 0, sources: new Set<string>(), evidence: [], co: new Map<string, number>() };
      a.raw += s.weight;
      a.sources.add(s.source);
      if (a.evidence.length < 5) a.evidence.push(s.label);
      for (const other of kws) if (other !== kw) a.co.set(other, (a.co.get(other) ?? 0) + s.weight);
      agg.set(kw, a);
    }
  }
  const trends: Trend[] = [];
  for (const [theme, a] of agg) {
    // Cross-source confirmation (on-chain volume AND social chatter) is the strongest signal.
    const crossBoost = a.sources.size > 1 ? 1.25 : 1;
    const rawScore = (1 - Math.exp(-(a.raw * crossBoost) / 1.5));
    trends.push({
      theme,
      score: rawScore,
      rawScore,
      sources: [...a.sources].sort(),
      related: [...a.co.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([w]) => w),
      evidence: a.evidence,
    });
  }
  return trends.sort((x, y) => y.score - x.score).slice(0, topN);
}

/**
 * Learning loop: sources whose past launches did well get up to 1.5x, poor ones down to 0.5x.
 * Laplace smoothing keeps it at 1.0x until there is data.
 */
export function sourceMultiplier(state: AgentState, sources: string[]): number {
  if (sources.length === 0) return 1;
  const ms = sources.map((s) => {
    const st = state.sourceStats[s] ?? { launches: 0, successes: 0 };
    const rate = (st.successes + 1) / (st.launches + 2);
    return 0.5 + rate * 2 * 0.5; // rate 0 -> 0.5, rate 0.5 -> 1.0, rate 1 -> 1.5
  });
  return ms.reduce((a, b) => a + b, 0) / ms.length;
}

/** Choose the single dominant meta: learning-adjusted, not recently used, above threshold. */
export function pickTrend(
  trends: Trend[],
  state: AgentState,
  cfg: Pick<Config, "MIN_TREND_SCORE" | "THEME_COOLDOWN_HOURS">,
  now: Date,
): Trend | undefined {
  const cutoff = now.getTime() - cfg.THEME_COOLDOWN_HOURS * 3_600_000;
  const recent = new Set(
    state.launches.filter((l) => Date.parse(l.createdAt) >= cutoff).map((l) => l.theme.toLowerCase()),
  );
  return trends
    .map((t) => ({ ...t, score: Math.min(1, t.rawScore * sourceMultiplier(state, t.sources)) }))
    .filter((t) => !recent.has(t.theme) && t.score >= cfg.MIN_TREND_SCORE)
    .sort((a, b) => b.score - a.score)[0];
}

// ---------------------------------------------------------------- sources

interface DexBoost {
  chainId: string;
  tokenAddress: string;
  description?: string;
  totalAmount?: number;
}
interface DexPair {
  chainId: string;
  baseToken: { address: string; name: string; symbol: string };
  volume?: { h1?: number; h24?: number };
  priceChange?: { h1?: number };
  txns?: { h1?: { buys?: number; sells?: number } };
}

export async function fetchDexSignals(cfg: Pick<Config, "DEXSCREENER_API_URL">, fetchImpl: typeof fetch = fetch): Promise<Signal[]> {
  const base = cfg.DEXSCREENER_API_URL.replace(/\/+$/, "");
  const lists = await Promise.allSettled([
    httpJson<DexBoost[]>(`${base}/token-boosts/top/v1`, {}, { fetchImpl, label: "dexscreener" }),
    httpJson<DexBoost[]>(`${base}/token-profiles/latest/v1`, {}, { fetchImpl, label: "dexscreener" }),
  ]);
  if (lists.every((l) => l.status === "rejected")) {
    throw new Error(`dexscreener unreachable: ${String((lists[0] as PromiseRejectedResult).reason)}`);
  }
  const sol = lists
    .flatMap((l) => (l.status === "fulfilled" ? (l.value ?? []) : []))
    .filter((b) => b.chainId === "solana");
  const descByAddr = new Map(sol.map((b) => [b.tokenAddress, b.description ?? ""]));
  const addrs = [...descByAddr.keys()].slice(0, 30);
  if (addrs.length === 0) return [];

  const pairs = await httpJson<DexPair[]>(`${base}/tokens/v1/solana/${addrs.join(",")}`, {}, { fetchImpl, label: "dexscreener" });
  const best = new Map<string, DexPair>();
  for (const p of pairs ?? []) {
    const prev = best.get(p.baseToken.address);
    if (!prev || (p.volume?.h1 ?? 0) > (prev.volume?.h1 ?? 0)) best.set(p.baseToken.address, p);
  }
  return [...best.values()].map((p) => {
    const vol = p.volume?.h1 ?? 0;
    const change = Math.max(0, Math.min(300, p.priceChange?.h1 ?? 0));
    const weight = (Math.log10(1 + vol) / 6) * (1 + change / 300);
    return {
      source: "dexscreener" as const,
      label: `$${p.baseToken.symbol} vol1h=$${Math.round(vol)} chg1h=${p.priceChange?.h1 ?? 0}%`,
      text: `${p.baseToken.name} ${p.baseToken.symbol} ${descByAddr.get(p.baseToken.address) ?? ""}`,
      weight,
    };
  });
}

interface XSearch {
  data?: { text: string; public_metrics?: { like_count?: number; retweet_count?: number; quote_count?: number } }[];
}

export async function fetchXSignals(
  cfg: Pick<Config, "X_API_BEARER_TOKEN" | "X_SEARCH_QUERY">,
  fetchImpl: typeof fetch = fetch,
): Promise<Signal[]> {
  if (!cfg.X_API_BEARER_TOKEN) return [];
  const url = new URL("https://api.x.com/2/tweets/search/recent");
  url.searchParams.set("query", cfg.X_SEARCH_QUERY);
  url.searchParams.set("max_results", "100");
  url.searchParams.set("tweet.fields", "public_metrics");
  const res = await httpJson<XSearch>(url.toString(), { headers: { Authorization: `Bearer ${cfg.X_API_BEARER_TOKEN}` } }, { fetchImpl, label: "x", retries: 1 });
  return (res.data ?? []).map((t) => {
    const m = t.public_metrics ?? {};
    const engagement = (m.like_count ?? 0) + 2 * (m.retweet_count ?? 0) + (m.quote_count ?? 0);
    return { source: "x" as const, label: `tweet ${engagement} eng`, text: t.text, weight: Math.log10(1 + engagement) / 4 };
  });
}

/** Self-healing: each source fails independently; the scan only fails if every source does. */
export async function scanTrends(
  cfg: Pick<Config, "DEXSCREENER_API_URL" | "X_API_BEARER_TOKEN" | "X_SEARCH_QUERY">,
  fetchImpl: typeof fetch = fetch,
): Promise<Trend[]> {
  const results = await Promise.allSettled([fetchDexSignals(cfg, fetchImpl), fetchXSignals(cfg, fetchImpl)]);
  const signals: Signal[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") signals.push(...r.value);
    else log.warn("trend source failed", { source: i === 0 ? "dexscreener" : "x", error: String(r.reason) });
  });
  const dexFailed = results[0].status === "rejected";
  const xUsable = Boolean(cfg.X_API_BEARER_TOKEN) && results[1].status === "fulfilled";
  if (dexFailed && !xUsable) throw new Error("all trend sources failed");
  const trends = scoreThemes(signals);
  log.info("trends scanned", { signals: signals.length, top: trends.slice(0, 5).map((t) => `${t.theme}:${t.score.toFixed(2)}`) });
  return trends;
}

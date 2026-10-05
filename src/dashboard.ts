import { lamportsToSol } from "./config.js";
import type { AgentState, LaunchRecord } from "./store.js";

export interface ContestRow {
  name: string;
  wins: number; // launches where this provider's entry won
  settled: number; // of those, how many have a 24h result
  successes: number;
}

export interface LaunchRow {
  id: string;
  createdAt: string;
  name: string;
  ticker: string;
  theme: string;
  dryRun: boolean;
  mint: string | null;
  pumpUrl: string | null;
  imageUri: string | null;
  buySol: number;
  feesSol: number;
  lastMcapUsd: number | null;
  outcome: LaunchRecord["outcome"];
  llmWinner: string;
  imageWinner: string;
  posts: { channel: string; ok: boolean; url?: string }[];
  mcapHistory: { at: string; usd: number }[];
}

export interface AgentStatus {
  lastRunAt: string | null;
  lastStatus: string | null;
  nextRunAt: string | null;
  consecutiveFailures: number;
}

export interface AgentSettings {
  launchHoursUtc: string;
  cycleIntervalMin: number;
  maxLaunchesPerDay: number;
  maxDailySpendSol: number;
  initialBuyMinSol: number;
  initialBuyMaxSol: number;
  minTrendScore: number;
  llms: string[];
  images: string[];
}

export interface DashboardSummary {
  generatedAt: string;
  dryRun: boolean;
  wallet: string | null;
  balanceSol: number | null;
  pausedUntil: string | null;
  totals: {
    live: number;
    dryRuns: number;
    pending: number;
    successes: number;
    duds: number;
    winRate: number | null; // successes / settled
    spentSol: number; // initial buys (live only)
    feesSol: number; // creator fees collected
    feesMinusBuysSol: number; // excludes the value of tokens still held
  };
  contests: { llm: ContestRow[]; image: ContestRow[] };
  sources: { name: string; launches: number; successes: number }[];
  launches: LaunchRow[];
  status: AgentStatus | null;
  settings: AgentSettings | null;
}

function contest(launches: LaunchRecord[], key: "llmWinner" | "imageWinner"): ContestRow[] {
  const rows = new Map<string, ContestRow>();
  for (const l of launches) {
    const r = rows.get(l[key]) ?? { name: l[key], wins: 0, settled: 0, successes: 0 };
    r.wins++;
    if (!l.dryRun && l.outcome !== "pending") r.settled++;
    if (!l.dryRun && l.outcome === "success") r.successes++;
    rows.set(l[key], r);
  }
  return [...rows.values()].sort((a, b) => b.wins - a.wins);
}

/** Pure: everything the dashboard shows, computed from saved state. */
export function buildSummary(
  state: AgentState,
  opts: {
    dryRun: boolean;
    wallet: string | null;
    balanceSol: number | null;
    now?: Date;
    status?: AgentStatus;
    settings?: AgentSettings;
  },
): DashboardSummary {
  const live = state.launches.filter((l) => !l.dryRun && l.mint);
  const settled = live.filter((l) => l.outcome !== "pending");
  const successes = settled.filter((l) => l.outcome === "success").length;
  const spent = live.reduce((s, l) => s + BigInt(l.initialBuyLamports), 0n);
  const fees = live.reduce((s, l) => s + BigInt(l.feesCollectedLamports), 0n);

  return {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    dryRun: opts.dryRun,
    wallet: opts.wallet,
    balanceSol: opts.balanceSol,
    pausedUntil: state.pausedUntil && Date.parse(state.pausedUntil) > (opts.now ?? new Date()).getTime() ? state.pausedUntil : null,
    totals: {
      live: live.length,
      dryRuns: state.launches.length - live.length,
      pending: live.length - settled.length,
      successes,
      duds: settled.length - successes,
      winRate: settled.length ? successes / settled.length : null,
      spentSol: lamportsToSol(spent),
      feesSol: lamportsToSol(fees),
      feesMinusBuysSol: lamportsToSol(fees - spent),
    },
    contests: { llm: contest(state.launches, "llmWinner"), image: contest(state.launches, "imageWinner") },
    sources: Object.entries(state.sourceStats)
      .map(([name, s]) => ({ name, ...s }))
      .sort((a, b) => b.launches - a.launches),
    launches: [...state.launches]
      .reverse()
      .slice(0, 100)
      .map((l) => ({
        id: l.id,
        createdAt: l.createdAt,
        name: l.name,
        ticker: l.ticker,
        theme: l.theme,
        dryRun: l.dryRun,
        mint: l.mint ?? null,
        pumpUrl: l.mint ? `https://pump.fun/coin/${l.mint}` : null,
        imageUri: l.imageUri?.startsWith("https://") ? l.imageUri : null,
        buySol: lamportsToSol(BigInt(l.initialBuyLamports)),
        feesSol: lamportsToSol(BigInt(l.feesCollectedLamports)),
        lastMcapUsd: l.snapshots.at(-1)?.usdMarketCap ?? null,
        outcome: l.outcome,
        llmWinner: l.llmWinner,
        imageWinner: l.imageWinner,
        posts: (l.posts ?? []).map((p) => ({ channel: p.channel, ok: p.ok, ...(p.url ? { url: p.url } : {}) })),
        mcapHistory: l.snapshots.flatMap((sn) => (sn.usdMarketCap === null ? [] : [{ at: sn.at, usd: sn.usdMarketCap }])),
      })),
    status: opts.status ?? null,
    settings: opts.settings ?? null,
  };
}

export { DASHBOARD_HTML } from "./dashboardPage.js";

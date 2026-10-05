import { lamportsToSol } from "./config.js";
import type { AgentState, LaunchRecord } from "./store.js";

export interface ContestRow {
  name: string;
  wins: number; // launches where this provider's entry won
  settled: number; // of those, how many have a 24h result
  successes: number;
}

export interface LaunchRow {
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
  opts: { dryRun: boolean; wallet: string | null; balanceSol: number | null; now?: Date },
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
      })),
  };
}

/**
 * Single self-contained page (no external scripts). It fetches ./api/summary with the same
 * Basic-auth credentials the browser already sent for this page, and refreshes every 60s.
 * All text from the data goes through textContent - coin names come from an AI and are untrusted.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meme Agent</title>
<style>
:root {
  color-scheme: light;
  --bg: #f4f4f2; --surface: #fcfcfb; --border: #e3e2de;
  --text: #0b0b0b; --text-2: #52514e; --muted: #77766f;
  --accent: #2a78d6; --track: #ecebe7;
  --good: #0ca30c; --good-text: #006300; --critical: #d03b3b; --warning: #fab219;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #121211; --surface: #1a1a19; --border: #2e2e2c;
    --text: #ffffff; --text-2: #c3c2b7; --muted: #9a998f;
    --accent: #3987e5; --track: #2a2a28; --good-text: #4cc24c;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #121211; --surface: #1a1a19; --border: #2e2e2c;
  --text: #ffffff; --text-2: #c3c2b7; --muted: #9a998f;
  --accent: #3987e5; --track: #2a2a28; --good-text: #4cc24c;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; justify-content: space-between; margin-bottom: 20px; }
h1 { font-size: 22px; margin: 0; }
h2 { font-size: 15px; margin: 0 0 12px; color: var(--text-2); font-weight: 600; }
.meta { color: var(--muted); font-size: 13px; }
.pill { display: inline-block; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--border); font-size: 12px; font-weight: 600; color: var(--text-2); }
.banner { background: var(--surface); border: 1px solid var(--critical); border-radius: 10px; padding: 10px 14px; margin-bottom: 16px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 20px; }
.tile, .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
.tile .label { color: var(--text-2); font-size: 13px; }
.tile .value { font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; margin-top: 2px; }
.tile .sub { color: var(--muted); font-size: 12px; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; margin-bottom: 20px; }
.bar-row { display: grid; grid-template-columns: 70px 1fr 120px; gap: 10px; align-items: center; margin: 8px 0; }
.bar-track { height: 12px; background: var(--track); border-radius: 4px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--accent); border-radius: 0 4px 4px 0; min-width: 2px; }
.bar-val { color: var(--text-2); font-size: 12px; font-variant-numeric: tabular-nums; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { color: var(--text-2); font-weight: 600; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.coin { display: flex; align-items: center; gap: 8px; }
.coin img { width: 28px; height: 28px; border-radius: 6px; object-fit: cover; background: var(--track); }
.coin .tk { color: var(--muted); font-size: 12px; }
.badge { font-weight: 600; font-size: 12px; }
.badge.success { color: var(--good-text); }
.badge.dud { color: var(--critical); }
.badge.pending, .badge.test { color: var(--muted); }
a { color: var(--accent); }
.empty { color: var(--muted); padding: 24px 0; text-align: center; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Meme Agent</h1>
    <div class="meta"><span id="mode" class="pill"></span> <span id="updated"></span></div>
  </header>
  <div id="paused" class="banner" hidden></div>
  <section class="tiles" id="tiles" aria-label="Totals"></section>
  <section class="grid2">
    <div class="card"><h2>Coin idea contest (wins)</h2><div id="llm"></div></div>
    <div class="card"><h2>Logo contest (wins)</h2><div id="image"></div></div>
  </section>
  <section class="card">
    <h2>Launches</h2>
    <div class="table-wrap"><table id="launches">
      <thead><tr><th>When</th><th>Coin</th><th>Theme</th><th>Result</th><th class="num">Mkt cap</th><th class="num">Buy (SOL)</th><th class="num">Fees (SOL)</th><th>Won by</th><th>Links</th></tr></thead>
      <tbody></tbody>
    </table></div>
  </section>
</main>
<script>
const el = (tag, props = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") n.textContent = v; else if (k === "cls") n.className = v; else n.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c) n.append(c);
  return n;
};
const sol = (v) => (v === null || v === undefined) ? "–" : (Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4));
const usd = (v) => v === null ? "–" : "$" + (v >= 1000 ? (v / 1000).toFixed(1) + "k" : Math.round(v));
const when = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const safeUrl = (u) => typeof u === "string" && /^https:\\/\\//.test(u) ? u : null;

function tile(label, value, sub) {
  return el("div", { cls: "tile" }, [el("div", { cls: "label", text: label }), el("div", { cls: "value", text: value }), sub ? el("div", { cls: "sub", text: sub }) : null]);
}
function bars(target, rows) {
  target.replaceChildren();
  if (!rows.length) { target.append(el("div", { cls: "empty", text: "No launches yet" })); return; }
  const max = Math.max(...rows.map((r) => r.wins), 1);
  for (const r of rows) {
    const rate = r.settled ? Math.round((r.successes / r.settled) * 100) + "% hit" : "no results yet";
    const fill = el("div", { cls: "bar-fill", style: "width:" + (r.wins / max) * 100 + "%" });
    target.append(el("div", { cls: "bar-row", title: r.name + ": " + r.wins + " wins, " + r.successes + "/" + r.settled + " successful" }, [
      el("div", { text: r.name }),
      el("div", { cls: "bar-track" }, fill),
      el("div", { cls: "bar-val", text: r.wins + " wins · " + rate }),
    ]));
  }
}
const OUTCOME = { success: "✓ Success", dud: "✕ Flop", pending: "… Waiting 24h", test: "Test run" };

async function load() {
  const res = await fetch("api/summary", { credentials: "same-origin" });
  if (!res.ok) { document.getElementById("updated").textContent = "Error " + res.status; return; }
  const s = await res.json();
  const t = s.totals;
  document.getElementById("mode").textContent = s.dryRun ? "TEST MODE (no SOL spent)" : "LIVE";
  document.getElementById("updated").textContent = "Updated " + when(s.generatedAt);
  const paused = document.getElementById("paused");
  paused.hidden = !s.pausedUntil;
  if (s.pausedUntil) paused.textContent = "⏸ Launching paused until " + when(s.pausedUntil) + " (too many flops in a row).";

  document.getElementById("tiles").replaceChildren(
    tile("Wallet (SOL)", s.balanceSol === null ? "–" : sol(s.balanceSol), s.wallet ? s.wallet.slice(0, 4) + "…" + s.wallet.slice(-4) : "no wallet"),
    tile("Coins launched", String(t.live), t.dryRuns + " test runs"),
    tile("Spent (SOL)", sol(t.spentSol), "initial buys"),
    tile("Fees earned (SOL)", sol(t.feesSol), "creator fees collected"),
    tile("Winners", t.winRate === null ? "–" : Math.round(t.winRate * 100) + "%", t.successes + " won · " + t.duds + " flopped · " + t.pending + " waiting"),
    tile("Fees − buys (SOL)", (t.feesMinusBuysSol >= 0 ? "+" : "") + sol(t.feesMinusBuysSol), "excludes tokens you still hold"),
  );
  bars(document.getElementById("llm"), s.contests.llm);
  bars(document.getElementById("image"), s.contests.image);

  const body = document.querySelector("#launches tbody");
  body.replaceChildren();
  if (!s.launches.length) body.append(el("tr", {}, el("td", { colspan: "9", cls: "empty", text: "No launches yet. The bot will list them here." })));
  for (const l of s.launches) {
    const img = safeUrl(l.imageUri) ? el("img", { src: l.imageUri, alt: "", loading: "lazy" }) : el("img", { alt: "" });
    const key = l.dryRun ? "test" : l.outcome;
    const links = el("td");
    const pump = safeUrl(l.pumpUrl);
    if (pump) links.append(el("a", { href: pump, target: "_blank", rel: "noopener", text: "pump.fun" }));
    for (const p of l.posts) {
      const u = safeUrl(p.url);
      if (p.ok && u) links.append(" · ", el("a", { href: u, target: "_blank", rel: "noopener", text: p.channel }));
      else if (!p.ok) links.append(" · ", el("span", { cls: "badge dud", text: p.channel + " failed" }));
    }
    body.append(el("tr", {}, [
      el("td", { text: when(l.createdAt) }),
      el("td", {}, el("div", { cls: "coin" }, [img, el("div", {}, [el("div", { text: l.name }), el("div", { cls: "tk", text: "$" + l.ticker })])])),
      el("td", { text: l.theme }),
      el("td", {}, el("span", { cls: "badge " + key, text: OUTCOME[key] || key })),
      el("td", { cls: "num", text: usd(l.lastMcapUsd) }),
      el("td", { cls: "num", text: sol(l.buySol) }),
      el("td", { cls: "num", text: sol(l.feesSol) }),
      el("td", { text: l.llmWinner + " / " + l.imageWinner }),
      links,
    ]));
  }
}
load();
setInterval(load, 60000);
</script>
</body>
</html>`;

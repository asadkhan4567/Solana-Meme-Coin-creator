import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { runCycle, type AgentDeps } from "../src/agent.js";
import { applyCircuitBreaker, trackPerformance } from "../src/strategies/performanceTracker.js";
import { Store, type LaunchRecord } from "../src/store.js";
import type { Trend } from "../src/trendScanner.js";
import { fakeCreateTx, fakeImage, fakeLlm, fakeRpc, jsonResponse, testConfig } from "./helpers.js";

const trend: Trend = { theme: "frog", score: 0.9, rawScore: 0.9, sources: ["dexscreener", "x"], related: ["king"], evidence: ["$FROG"] };
const concept = { name: "Crown Croak", ticker: "CROAK", description: "A toad who crowned himself king of the pond.", imagePrompt: "a toad with a tiny crown" };

function deps(overrides: Partial<AgentDeps> = {}, env: Record<string, string> = {}): AgentDeps {
  const cfg = testConfig(env);
  const wallet = Keypair.generate();
  const { b64, mint } = fakeCreateTx(wallet.publicKey);
  return {
    cfg,
    store: new Store(cfg.DATA_DIR),
    llms: [fakeLlm("claude", concept, [6, 6]), fakeLlm("gpt", { ...concept, ticker: "KROAK" }, [5, 9])],
    images: [fakeImage("dalle"), fakeImage("flux")],
    rpc: fakeRpc({ balance: 1_000_000_000, simErr: null, sent: [], simulated: 0 }),
    wallet,
    fetchImpl: (async () => jsonResponse({ transaction: b64, mintPublicKey: mint.publicKey.toBase58() })) as typeof fetch,
    now: () => new Date("2026-10-05T15:00:00Z"),
    scan: async () => [trend],
    ...overrides,
  };
}

describe("agent cycle", () => {
  it("dry run end to end: trend -> contest -> simulated deploy -> artifacts saved", async () => {
    const d = deps();
    const r = await runCycle(d);
    expect(r.status).toBe("dry_run");
    expect(r.ticker).toBe("KROAK");
    expect(r.initialBuySol).toBeCloseTo(0.0411, 4); // 0.9 trend score -> ~78% of the way from 0.01 to 0.05
    for (const f of ["summary.json", "metadata.json", "logo-dalle.png", "logo-flux.png"]) {
      expect(fs.existsSync(path.join(r.outDir!, f))).toBe(true);
    }
    expect(d.store.state.launches[0]).toMatchObject({ dryRun: true, ticker: "KROAK", llmWinner: "gpt" });
  });

  it("skips when no trend is strong enough (no paid API calls)", async () => {
    const d = deps({ scan: async () => [{ ...trend, rawScore: 0.2, score: 0.2 }] });
    const r = await runCycle(d);
    expect(r.status).toBe("skipped");
    expect((d.llms[0] as ReturnType<typeof fakeLlm>).calls).toHaveLength(0);
  });

  it("reports failure instead of crashing", async () => {
    const d = deps({ scan: async () => { throw new Error("all trend sources failed"); } });
    const r = await runCycle(d);
    expect(r).toMatchObject({ status: "failed", reason: "all trend sources failed" });
  });
});

describe("performance tracker", () => {
  const base = (i: number, createdAt: string): LaunchRecord => ({
    id: String(i), createdAt, dryRun: false, theme: `t${i}`, trendScore: 0.7, sources: ["x"], name: "N", ticker: "NN",
    llmWinner: "gpt", imageWinner: "flux", metadataUri: "u", initialBuyLamports: "1", mint: `M${i}`, snapshots: [],
    outcome: "pending", feesCollectedLamports: "0",
  });

  it("labels coins after 24h, updates source stats, and trips the circuit breaker", async () => {
    const cfg = testConfig({ LOSS_STREAK_PAUSE: "3" });
    const store = new Store(cfg.DATA_DIR);
    for (let i = 0; i < 3; i++) store.addLaunch(base(i, "2026-10-01T00:00:00Z"));
    const fetchImpl = (async () => jsonResponse({ usd_market_cap: 4000, complete: false })) as typeof fetch;
    const now = new Date("2026-10-03T00:00:00Z");
    await trackPerformance(cfg, store, now, fetchImpl);
    expect(store.state.launches.every((l) => l.outcome === "dud")).toBe(true);
    expect(store.state.sourceStats.x).toEqual({ launches: 3, successes: 0 });
    expect(store.state.pausedUntil).toBe("2026-10-04T00:00:00.000Z");
    // does not re-trip for the same streak
    expect(await applyCircuitBreaker(cfg, store, new Date("2026-10-05T00:00:00Z"))).toBe(false);
  });

  it("counts graduated coins as successes", async () => {
    const cfg = testConfig();
    const store = new Store(cfg.DATA_DIR);
    store.addLaunch(base(1, "2026-10-01T00:00:00Z"));
    const fetchImpl = (async () => jsonResponse({ usd_market_cap: 9000, complete: true })) as typeof fetch;
    await trackPerformance(cfg, store, new Date("2026-10-03T00:00:00Z"), fetchImpl);
    expect(store.state.launches[0]!.outcome).toBe("success");
  });
});

describe("agent cycle: posting and don't-copy", () => {
  const liveEnv = { DRY_RUN: "false", SIGNER_PRIVATE_KEY: "x", PINATA_JWT: "j", SOLANA_RPC_URL: "https://rpc.test", TELEGRAM_BOT_TOKEN: "1:T", TELEGRAM_CHANNEL_ID: "@chan" };

  function routed(d: AgentDeps, extra: (url: string) => Response | undefined) {
    const original = d.fetchImpl!;
    d.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      return extra(url) ?? original(input, init);
    }) as typeof fetch;
    return d;
  }

  it("live launch: uploads, launches, then posts to Telegram and records the link", async () => {
    const d = routed(deps({}, liveEnv), (url) => {
      if (url.includes("/coins/search") ) return jsonResponse([]);
      if (url.includes("/latest/dex/search")) return jsonResponse({ pairs: [] });
      if (url.includes("pinata")) return jsonResponse({ IpfsHash: "Qm123" });
      if (url.includes("api.telegram.org")) return jsonResponse({ ok: true, result: { message_id: 7, chat: { username: "chan" } } });
      return undefined;
    });
    const r = await runCycle(d);
    expect(r.status).toBe("launched");
    const rec = d.store.state.launches[0]!;
    expect(rec.imageUri).toBe("https://ipfs.io/ipfs/Qm123");
    expect(rec.posts).toEqual([{ channel: "telegram", ok: true, url: "https://t.me/chan/7" }]);
  });

  it("dry run writes a post preview instead of posting", async () => {
    const r = await runCycle(deps({}, { TELEGRAM_BOT_TOKEN: "1:T", TELEGRAM_CHANNEL_ID: "@chan" }));
    const preview = fs.readFileSync(path.join(r.outDir!, "posts-preview.txt"), "utf8");
    expect(preview).toContain("--- x ---");
    expect(preview).toContain("$KROAK");
  });

  it("skips concepts whose ticker is already on pump.fun", async () => {
    const d = routed(deps(), (url) => {
      if (url.includes("/coins/search") && url.includes("KROAK")) return jsonResponse([{ name: "x", symbol: "KROAK" }]);
      if (url.includes("/coins/search")) return jsonResponse([]);
      if (url.includes("/latest/dex/search")) return jsonResponse({ pairs: [] });
      return undefined;
    });
    const r = await runCycle(d);
    expect(r.ticker).toBe("CROAK");
  });
});

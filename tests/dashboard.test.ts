import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { buildSummary } from "../src/dashboard.js";
import { createControlServer, Scheduler } from "../src/index.js";
import { Store, type LaunchRecord } from "../src/store.js";
import { testConfig } from "./helpers.js";

const rec = (p: Partial<LaunchRecord>): LaunchRecord => ({
  id: "x", createdAt: "2026-10-01T00:00:00Z", dryRun: false, theme: "frog", trendScore: 0.7, sources: ["x"],
  name: "Crown Croak", ticker: "CROAK", llmWinner: "gpt", imageWinner: "flux", metadataUri: "u",
  imageUri: "https://ipfs.io/ipfs/img", initialBuyLamports: "50000000", mint: "M1", snapshots: [],
  outcome: "pending", feesCollectedLamports: "0", ...p,
});

describe("dashboard summary", () => {
  it("totals spend, fees, winners and contest wins", () => {
    const state = {
      version: 1 as const,
      sourceStats: { x: { launches: 2, successes: 1 } },
      launches: [
        rec({ outcome: "success", feesCollectedLamports: "80000000", snapshots: [{ at: "t", usdMarketCap: 42000, complete: false, replyCount: 3 }] }),
        rec({ outcome: "dud", llmWinner: "claude", imageWinner: "dalle" }),
        rec({ outcome: "pending" }),
        rec({ dryRun: true, mint: undefined, llmWinner: "claude", imageUri: "ipfs://dry-run-image" }),
      ],
    };
    const s = buildSummary(state, { dryRun: false, wallet: "W", balanceSol: 1.5, now: new Date("2026-10-05T00:00:00Z") });
    expect(s.totals).toMatchObject({ live: 3, dryRuns: 1, successes: 1, duds: 1, pending: 1, winRate: 0.5, spentSol: 0.15, feesSol: 0.08 });
    expect(s.totals.feesMinusBuysSol).toBeCloseTo(-0.07);
    expect(s.contests.llm).toEqual([
      { name: "gpt", wins: 2, settled: 1, successes: 1 },
      { name: "claude", wins: 2, settled: 1, successes: 0 },
    ]);
    expect(s.launches[0]!.imageUri).toBeNull(); // non-https image never reaches the page
    expect(s.launches[3]!.lastMcapUsd).toBe(42000);
    expect(s.launches[3]!.pumpUrl).toBe("https://pump.fun/coin/M1");
  });
});

describe("dashboard server", () => {
  const cfg = testConfig({ AGENT_API_TOKEN: "s3cret-token" });
  const deps = { cfg, store: new Store(cfg.DATA_DIR), llms: [], images: [] };
  deps.store.addLaunch(rec({}));
  const server = createControlServer(deps, new Scheduler(deps)).listen(0);
  const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const basic = (pw: string) => ({ Authorization: "Basic " + Buffer.from(`me:${pw}`).toString("base64") });
  afterAll(() => server.close());

  it("asks the browser to log in", async () => {
    const r = await fetch(`${base()}/dashboard`);
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/Basic/);
    expect((await fetch(`${base()}/dashboard`, { headers: basic("wrong") })).status).toBe(401);
  });

  it("serves the page and the data with the token as password", async () => {
    const page = await fetch(`${base()}/dashboard`, { headers: basic("s3cret-token") });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await page.text()).toContain("Meme Agent");
    const data = await fetch(`${base()}/api/summary`, { headers: basic("s3cret-token") });
    expect((await data.json()).totals.live).toBe(1);
  });

  it("still accepts Bearer for n8n", async () => {
    const r = await fetch(`${base()}/api/summary`, { headers: { Authorization: "Bearer s3cret-token" } });
    expect(r.status).toBe(200);
  });
});

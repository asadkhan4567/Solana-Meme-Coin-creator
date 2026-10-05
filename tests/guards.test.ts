import { describe, expect, it } from "vitest";
import { canLaunch, checkNameAllowed, isWithinLaunchHours, requiredLamports, sizeInitialBuy } from "../src/guards.js";
import type { AgentState, LaunchRecord } from "../src/store.js";
import { testConfig } from "./helpers.js";

const cfg = testConfig();
const now = new Date("2026-10-05T15:00:00Z");

function launch(p: Partial<LaunchRecord>): LaunchRecord {
  return {
    id: "x", createdAt: now.toISOString(), dryRun: false, theme: "frog", trendScore: 0.7, sources: ["x"], name: "N",
    ticker: "NN", llmWinner: "gpt", imageWinner: "flux", metadataUri: "u", initialBuyLamports: "50000000", mint: "M",
    snapshots: [], outcome: "pending", feesCollectedLamports: "0", ...p,
  };
}
const state = (launches: LaunchRecord[] = [], extra: Partial<AgentState> = {}): AgentState => ({ version: 1, launches, sourceStats: {}, ...extra });

describe("name filter", () => {
  it("blocks celebrities, brands and big tickers, even joined into one word", () => {
    expect(checkNameAllowed("Elon Frog", "EFROG").ok).toBe(false);
    expect(checkNameAllowed("TeslaCat", "TCAT").ok).toBe(false);
    expect(checkNameAllowed("Baby Doge", "BDOGE").ok).toBe(false);
    expect(checkNameAllowed("Sleepy Toad", "TOAD", ["toad"]).ok).toBe(false);
  });
  it("allows original names", () => {
    expect(checkNameAllowed("Sleepy Toad", "ZZTOAD").ok).toBe(true);
  });
  it("validates ticker format", () => {
    expect(checkNameAllowed("Sleepy Toad", "zz-toad").ok).toBe(false);
  });
});

describe("launch hours", () => {
  it("supports plain and wrap-around ranges", () => {
    expect(isWithinLaunchHours(now, "")).toBe(true);
    expect(isWithinLaunchHours(now, "13-23")).toBe(true);
    expect(isWithinLaunchHours(now, "0-8")).toBe(false);
    expect(isWithinLaunchHours(new Date("2026-10-05T02:00:00Z"), "22-4")).toBe(true);
  });
});

describe("canLaunch", () => {
  it("enforces the daily launch cap (dry runs don't count)", () => {
    const three = [launch({}), launch({}), launch({})];
    expect(canLaunch(cfg, state(three), now).ok).toBe(false);
    expect(canLaunch(cfg, state(three.map((l) => ({ ...l, dryRun: true }))), now).ok).toBe(true);
  });
  it("enforces the daily spend cap", () => {
    expect(canLaunch(cfg, state([launch({ initialBuyLamports: "195000000" })]), now).ok).toBe(false);
  });
  it("respects the circuit-breaker pause", () => {
    expect(canLaunch(cfg, state([], { pausedUntil: "2026-10-06T00:00:00Z" }), now).reason).toMatch(/paused/);
  });
});

describe("position sizing", () => {
  it("scales the buy with trend strength between min and max", () => {
    expect(sizeInitialBuy(cfg.MIN_TREND_SCORE, cfg, 0n)).toBe(10_000_000n);
    expect(sizeInitialBuy(1, cfg, 0n)).toBe(50_000_000n);
  });
  it("never exceeds the remaining daily budget", () => {
    expect(sizeInitialBuy(1, cfg, 180_000_000n)).toBe(20_000_000n);
  });
  it("requires buy + buffer + reserve in the wallet", () => {
    expect(requiredLamports(50_000_000n, cfg)).toBe(130_000_000n);
  });
});

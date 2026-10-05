import { describe, expect, it } from "vitest";
import { extractKeywords, pickTrend, scanTrends, scoreThemes, sourceMultiplier, type Signal } from "../src/trendScanner.js";
import type { AgentState } from "../src/store.js";
import { jsonResponse, testConfig } from "./helpers.js";

const cfg = testConfig();
const now = new Date("2026-10-05T15:00:00Z");
const empty = (): AgentState => ({ version: 1, launches: [], sourceStats: {} });

describe("keywords", () => {
  it("drops stopwords, crypto filler and numbers; keeps hashtags/cashtags", () => {
    expect(extractKeywords("The FROG coin on Solana! #frogking $TOAD 1000x lfg")).toEqual(["frog", "frogking", "toad"]);
  });
});

describe("scoring", () => {
  const signals: Signal[] = [
    { source: "dexscreener", label: "$FROG", text: "Frog King frog", weight: 0.8 },
    { source: "x", label: "tweet", text: "frog szn is here #frog", weight: 0.6 },
    { source: "x", label: "tweet", text: "cat vibes", weight: 0.3 },
  ];
  it("ranks cross-source themes first and records related words", () => {
    const [top] = scoreThemes(signals);
    expect(top!.theme).toBe("frog");
    expect(top!.sources).toEqual(["dexscreener", "x"]);
    expect(top!.related).toContain("king");
    expect(top!.score).toBeGreaterThan(0.6);
  });

  it("learning multiplier rewards sources with past winners", () => {
    const s = empty();
    expect(sourceMultiplier(s, ["x"])).toBeCloseTo(1);
    s.sourceStats.x = { launches: 8, successes: 7 };
    s.sourceStats.dexscreener = { launches: 8, successes: 0 };
    expect(sourceMultiplier(s, ["x"])).toBeGreaterThanOrEqual(1.3);
    expect(sourceMultiplier(s, ["dexscreener"])).toBeLessThan(0.7);
  });

  it("skips themes launched within the cooldown and weak themes", () => {
    const trends = scoreThemes(signals);
    const s = empty();
    s.launches.push({ theme: "frog", createdAt: now.toISOString() } as AgentState["launches"][number]);
    expect(pickTrend(trends, s, cfg, now)?.theme).not.toBe("frog");
    expect(pickTrend(trends, empty(), { ...cfg, MIN_TREND_SCORE: 0.99 }, now)).toBeUndefined();
  });
});

describe("scanTrends", () => {
  it("combines DexScreener data and survives a dead source", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("token-boosts")) return jsonResponse([{ chainId: "solana", tokenAddress: "A1", description: "the frog that ate the moon" }]);
      if (url.includes("token-profiles")) return new Response("down", { status: 500 });
      if (url.includes("/tokens/v1/solana/")) {
        return jsonResponse([{ chainId: "solana", baseToken: { address: "A1", name: "Moon Frog", symbol: "MFROG" }, volume: { h1: 250_000 }, priceChange: { h1: 120 } }]);
      }
      throw new Error("unexpected " + url);
    }) as typeof fetch;
    const trends = await scanTrends({ ...cfg, DEXSCREENER_API_URL: "https://dex.test" }, fetchImpl);
    expect(trends[0]!.theme).toBe("frog");
    expect(trends[0]!.evidence[0]).toMatch(/MFROG/);
  });
});

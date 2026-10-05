import { describe, expect, it } from "vitest";
import { runCreativeDirector } from "../src/creativeDirector.js";
import { parseJsonReply } from "../src/lib/llm.js";
import type { Trend } from "../src/trendScanner.js";
import { fakeImage, fakeLlm, tmpDir } from "./helpers.js";

const trend: Trend = { theme: "frog", score: 0.8, rawScore: 0.8, sources: ["x"], related: ["king"], evidence: ["$FROG"] };
const concept = (name: string, ticker: string) => ({
  name,
  ticker,
  description: `${name} is a very sleepy amphibian.`,
  imagePrompt: "a sleepy green toad wearing a crown",
});

describe("creative director", () => {
  it("runs Claude vs GPT and DALL-E vs Flux and keeps the panel's winners", async () => {
    // Both judges prefer option 2 (GPT's concept) and image 2 (flux).
    const claude = fakeLlm("claude", concept("Sleepy Toad", "ZZTOAD"), [5, 9]);
    const gpt = fakeLlm("gpt", concept("Crown Croak", "$croak"), [4, 8]);
    const r = await runCreativeDirector(trend, [claude, gpt], [fakeImage("dalle"), fakeImage("flux")], tmpDir());
    expect(r.llmWinner).toBe("gpt");
    expect(r.concept.ticker).toBe("CROAK"); // "$croak" normalised
    expect(r.concepts.map((c) => c.score)).toEqual([17, 9]);
    expect(r.imageWinner).toBe("flux");
  });

  it("drops concepts that hit the name filter and keeps going", async () => {
    const claude = fakeLlm("claude", concept("Elon Toad", "ETOAD"), [5]);
    const gpt = fakeLlm("gpt", concept("Crown Croak", "CROAK"), [5]);
    const r = await runCreativeDirector(trend, [claude, gpt], [fakeImage("dalle")], tmpDir());
    expect(r.concepts).toHaveLength(1);
    expect(r.concept.name).toBe("Crown Croak");
  });

  it("self-heals when one image provider is down", async () => {
    const gpt = fakeLlm("gpt", concept("Crown Croak", "CROAK"), [5]);
    const r = await runCreativeDirector(trend, [gpt], [fakeImage("dalle", true), fakeImage("flux")], tmpDir());
    expect(r.imageWinner).toBe("flux");
  });

  it("fails clearly when every provider fails", async () => {
    const gpt = fakeLlm("gpt", concept("Crown Croak", "CROAK"), [5]);
    await expect(runCreativeDirector(trend, [gpt], [fakeImage("dalle", true)], tmpDir())).rejects.toThrow(/every image provider/);
  });
});

describe("parseJsonReply", () => {
  it("handles fenced and chatty replies", () => {
    expect(parseJsonReply('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonReply('here: {"a":{"b":2}} done')).toEqual({ a: { b: 2 } });
  });
});

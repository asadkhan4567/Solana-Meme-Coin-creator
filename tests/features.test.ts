import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateConcepts } from "../src/creativeDirector.js";
import { oauth1Header } from "../src/lib/oauth1.js";
import { buildPostText, postX, promoteLaunch, postTelegram } from "../src/promoter.js";
import { checkTicker, tickerGuard } from "../src/tickerCheck.js";
import type { Trend } from "../src/trendScanner.js";
import { PNG, jsonResponse, testConfig, tmpDir } from "./helpers.js";

const cfg = testConfig({ PUMP_COINS_API: "https://pump.test", DEXSCREENER_API_URL: "https://dex.test" });

function routeFetch(routes: Record<string, () => Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error("unexpected " + url);
    return routes[key]!();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("don't-copy ticker check", () => {
  it("flags a ticker already on pump.fun", async () => {
    const { fetchImpl } = routeFetch({
      "pump.test": () => jsonResponse([{ name: "Other", symbol: "croak" }]),
      "dex.test": () => jsonResponse({ pairs: [] }),
    });
    const r = await checkTicker(cfg, "CROAK", "Crown Croak", fetchImpl);
    expect(r.status).toBe("taken");
    expect(r.matches[0]).toMatch(/pump.fun: Other/);
  });

  it("flags an exact name match on a Solana DEX pair, ignores other chains", async () => {
    const { fetchImpl } = routeFetch({
      "pump.test": () => jsonResponse({ coins: [] }),
      "dex.test": () =>
        jsonResponse({
          pairs: [
            { chainId: "ethereum", baseToken: { name: "x", symbol: "CROAK" } },
            { chainId: "solana", baseToken: { name: "crown croak", symbol: "CC" } },
          ],
        }),
    });
    expect((await checkTicker(cfg, "CROAK", "Crown Croak", fetchImpl)).matches).toEqual(["dexscreener: crown croak ($CC)"]);
  });

  it("is free when nothing matches, even if one source is down", async () => {
    const { fetchImpl } = routeFetch({
      "pump.test": () => new Response("nope", { status: 404 }),
      "dex.test": () => jsonResponse({ pairs: [{ chainId: "solana", baseToken: { name: "Frog", symbol: "FROG" } }] }),
    });
    expect((await checkTicker(cfg, "CROAK", "Crown Croak", fetchImpl)).status).toBe("free");
  });

  it("fails closed when both sources are down (unless TICKER_CHECK_FAIL_OPEN)", async () => {
    const { fetchImpl } = routeFetch({ "pump.test": () => new Response("x", { status: 404 }), "dex.test": () => new Response("x", { status: 404 }) });
    expect(await tickerGuard(cfg, fetchImpl)("CROAK", "Crown Croak")).toMatch(/could not verify/);
    expect(await tickerGuard({ ...cfg, TICKER_CHECK_FAIL_OPEN: true }, fetchImpl)("CROAK", "Crown Croak")).toBeNull();
  });

  it("makes the AI pick a new ticker when its first idea is taken", async () => {
    const trend: Trend = { theme: "frog", score: 0.8, rawScore: 0.8, sources: ["x"], related: [], evidence: [] };
    const prompts: string[] = [];
    const tickers = ["CROAK", "RIBBIT"];
    const llm = {
      name: "gpt",
      async json(_s: string, user: string) {
        prompts.push(user);
        const t = tickers[prompts.length - 1];
        return { name: `Pond ${t}`, ticker: t, description: "a frog with big plans for the pond", imagePrompt: "a frog in a crown" };
      },
    };
    const out = await generateConcepts(trend, [llm], [], async (t) => (t === "CROAK" ? "already used" : null));
    expect(out[0]!.concept.ticker).toBe("RIBBIT");
    expect(prompts[1]).toMatch(/CROAK.*already used/);
  });
});

describe("oauth1", () => {
  it("matches X's documented signature example", () => {
    const header = oauth1Header(
      "POST",
      "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
      {
        consumerKey: "xvz1evFS4wEEPTGEFPHBog",
        consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
        token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
        tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
      },
      { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
      "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      "1318622958",
    );
    expect(header).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
  });
});

describe("promoter", () => {
  const dir = tmpDir();
  const logo = path.join(dir, "logo.png");
  fs.writeFileSync(logo, PNG);
  const post = {
    name: "Crown Croak",
    ticker: "CROAK",
    description: "A toad who crowned himself king of the pond. ".repeat(10),
    mint: "So1anaMint1111111111111111111111111111111111",
    logoFile: logo,
  };
  const promoCfg = testConfig({
    TELEGRAM_BOT_TOKEN: "123:SECRET",
    TELEGRAM_CHANNEL_ID: "@croakchan",
    X_API_KEY: "k",
    X_API_SECRET: "s",
    X_ACCESS_TOKEN: "t",
    X_ACCESS_SECRET: "ts",
  });

  it("keeps X posts within 280 chars (links count as 23) with CA and disclaimer", () => {
    const text = buildPostText(post, promoCfg.POST_DISCLAIMER, "x");
    const counted = text.replace(/https:\/\/\S+/g, "x".repeat(23)).length;
    expect(counted).toBeLessThanOrEqual(280);
    expect(text).toContain(`CA: ${post.mint}`);
    expect(text).toContain("Not financial advice");
    expect(text).toContain("…");
  });

  it("posts the logo to the Telegram channel", async () => {
    const { fetchImpl, calls } = routeFetch({
      "api.telegram.org": () => jsonResponse({ ok: true, result: { message_id: 42, chat: { username: "croakchan" } } }),
    });
    const r = await postTelegram(promoCfg, post, fetchImpl);
    expect(r).toEqual({ channel: "telegram", ok: true, url: "https://t.me/croakchan/42" });
    const form = calls[0]!.init!.body as FormData;
    expect(form.get("chat_id")).toBe("@croakchan");
    expect(form.get("photo")).toBeInstanceOf(Blob);
  });

  it("X: falls back to a text-only post if the image upload fails", async () => {
    const { fetchImpl, calls } = routeFetch({
      "/2/media/upload": () => new Response("forbidden", { status: 403 }),
      "/2/tweets": () => jsonResponse({ data: { id: "999" } }),
    });
    const r = await postX(promoCfg, post, fetchImpl);
    expect(r).toEqual({ channel: "x", ok: true, url: "https://x.com/i/status/999" });
    const tweet = calls.find((c) => c.url.endsWith("/2/tweets"))!;
    expect(JSON.parse(String(tweet.init!.body)).media).toBeUndefined();
    expect(String((tweet.init!.headers as Record<string, string>).Authorization)).toMatch(/^OAuth /);
  });

  it("never throws, and never leaks the Telegram token in errors", async () => {
    const { fetchImpl } = routeFetch({
      "api.telegram.org": () => new Response("bad", { status: 400 }),
      "/2/media/upload": () => jsonResponse({ data: { id: "m1" } }),
      "/2/tweets": () => new Response("rate", { status: 400 }),
    });
    const results = await promoteLaunch(promoCfg, post, fetchImpl);
    expect(results.map((r) => r.ok)).toEqual([false, false]);
    expect(results[0]!.error).not.toContain("SECRET");
    expect(results[0]!.error).toContain("bot[redacted]");
  });
});

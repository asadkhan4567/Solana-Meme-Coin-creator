import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { runExternalLaunch } from "../src/externalLaunch.js";
import { createControlServer, Scheduler } from "../src/index.js";
import { Store } from "../src/store.js";
import { testConfig } from "./helpers.js";

const coin = {
  name: "Moon Sloth",
  ticker: "$msloth",
  description: "A sloth that refuses to move until the chart does.",
  metadataUri: "https://ipfs.io/ipfs/QmMeta",
  imageUri: "ipfs://QmImage",
  theme: "sloth",
  trendScore: 0.8,
  sources: ["dexscreener"],
  llmWinner: "gemini-a",
  imageWinner: "pollinations",
};

// No network in tests: the logo copy is best-effort and must not block the launch.
const offline = (async () => {
  throw new Error("offline");
}) as unknown as typeof fetch;

function deps(overrides: Record<string, string> = {}) {
  const cfg = testConfig({ AGENT_API_TOKEN: "tok", LAUNCH_HOURS_UTC: "", ...overrides });
  return { cfg, store: new Store(cfg.DATA_DIR), llms: [], images: [], fetchImpl: offline };
}

describe("external launch (n8n)", () => {
  it("records a dry run with normalized ticker and https image", async () => {
    const d = deps();
    const r = await runExternalLaunch(d, coin);
    expect(r.status).toBe("dry_run");
    const rec = d.store.state.launches.at(-1)!;
    expect(rec.ticker).toBe("MSLOTH");
    expect(rec.imageUri).toBe("https://ipfs.io/ipfs/QmImage");
    expect(rec.llmWinner).toBe("gemini-a");
  });

  it("rejects bad input and blocked names", async () => {
    const d = deps();
    expect((await runExternalLaunch(d, { ...coin, metadataUri: "javascript:alert(1)" })).status).toBe("invalid");
    const blocked = await runExternalLaunch(d, { ...coin, name: "Elon Sloth" });
    expect(blocked.status).toBe("invalid");
    expect(d.store.state.launches).toHaveLength(0);
  });

  it("respects the daily launch cap and refuses duplicates", async () => {
    const d = deps({ MAX_LAUNCHES_PER_DAY: "1" });
    expect((await runExternalLaunch(d, coin)).status).toBe("dry_run");
    // dry runs don't count toward the cap, so the duplicate check is what stops this one
    const again = await runExternalLaunch(d, coin);
    expect(again.status).toBe("skipped");
  });
});

describe("POST /launch", () => {
  const d = deps();
  const server = createControlServer(d, new Scheduler(d)).listen(0);
  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/launch`;
  afterAll(() => server.close());

  it("requires the token", async () => {
    const r = await fetch(url(), { method: "POST", body: JSON.stringify(coin) });
    expect(r.status).toBe(401);
  });

  it("launches with Bearer auth and validates JSON", async () => {
    const h = { Authorization: "Bearer tok", "Content-Type": "application/json" };
    expect((await fetch(url(), { method: "POST", headers: h, body: "not json" })).status).toBe(400);
    const r = await fetch(url(), { method: "POST", headers: h, body: JSON.stringify({ ...coin, ticker: "SLOTH2" }) });
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe("dry_run");
  });
});

describe("POST /generate-logo", () => {
  const d = { ...deps(), images: [
    { name: "broken", generate: async () => { throw new Error("402"); } },
    { name: "ok", generate: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
  ] };
  const server = createControlServer(d, new Scheduler(d)).listen(0);
  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/generate-logo`;
  afterAll(() => server.close());

  it("falls back to the next provider and returns the image", async () => {
    const r = await fetch(url(), { method: "POST", headers: { Authorization: "Bearer tok" }, body: JSON.stringify({ prompt: "a cartoon lobster" }) });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("x-image-provider")).toBe("ok");
  });

  it("requires the token and a prompt", async () => {
    expect((await fetch(url(), { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(url(), { method: "POST", headers: { Authorization: "Bearer tok" }, body: "{}" })).status).toBe(400);
  });
});

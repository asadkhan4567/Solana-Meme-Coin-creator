import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, solToLamports } from "../src/config.js";
import { loadKeypair, parseSecretKey } from "../src/lib/wallet.js";

describe("config", () => {
  it("defaults to dry run with safe limits", () => {
    const cfg = loadConfig({ OPENAI_API_KEY: "x" });
    expect(cfg.DRY_RUN).toBe(true);
    expect(cfg.INITIAL_BUY_MAX_SOL).toBe(0.05);
    expect(cfg.MAX_LAUNCHES_PER_DAY).toBe(3);
  });

  it("treats empty strings as unset", () => {
    const cfg = loadConfig({ OPENAI_API_KEY: "x", DRY_RUN: "", MAX_LAUNCHES_PER_DAY: "", BLOCKED_TERMS: "" });
    expect(cfg.DRY_RUN).toBe(true);
    expect(cfg.MAX_LAUNCHES_PER_DAY).toBe(3);
    expect(cfg.BLOCKED_TERMS).toEqual([]);
  });

  it("refuses live mode without wallet, pinata and a real RPC", () => {
    expect(() => loadConfig({ OPENAI_API_KEY: "x", DRY_RUN: "false" })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ OPENAI_API_KEY: "x", DRY_RUN: "false", SIGNER_PRIVATE_KEY: "k", PINATA_JWT: "j", SOLANA_RPC_URL: "https://rpc.example" }),
    ).not.toThrow();
  });

  it("needs at least one LLM and image provider, and sane buy limits", () => {
    expect(() => loadConfig({})).toThrow(/OPENAI_API_KEY and\/or ANTHROPIC_API_KEY/);
    expect(() => loadConfig({ ANTHROPIC_API_KEY: "x" })).toThrow(/FAL_KEY/);
    expect(() => loadConfig({ OPENAI_API_KEY: "x", INITIAL_BUY_MIN_SOL: "0.1", INITIAL_BUY_MAX_SOL: "0.05" })).toThrow(/INITIAL_BUY_MAX_SOL/);
  });

  it("converts SOL to lamports exactly", () => {
    expect(solToLamports(0.05)).toBe(50_000_000n);
  });
});

describe("wallet", () => {
  const kp = Keypair.generate();

  it("parses a Phantom base58 key", () => {
    expect(loadKeypair(bs58.encode(kp.secretKey))!.publicKey.equals(kp.publicKey)).toBe(true);
  });

  it("parses a JSON byte array", () => {
    expect(loadKeypair(JSON.stringify([...kp.secretKey]))!.publicKey.equals(kp.publicKey)).toBe(true);
  });

  it("rejects bad keys without echoing them", () => {
    expect(() => parseSecretKey("not-a-key-0OIl")).toThrow(/neither base58/);
    expect(() => parseSecretKey(bs58.encode(Buffer.alloc(10)))).toThrow(/64 bytes/);
  });
});

import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { deployCoin, InsufficientFundsError } from "../src/coinDeployer.js";
import { fakeCreateTx, fakeRpc, jsonResponse, testConfig, type FakeChain } from "./helpers.js";

const wallet = Keypair.generate();
const params = { name: "Crown Croak", symbol: "CROAK", uri: "https://ipfs.io/ipfs/meta", initialBuyLamports: 50_000_000n };

function pumpApi(feePayer = wallet.publicKey) {
  const bodies: Record<string, unknown>[] = [];
  const { b64, mint } = fakeCreateTx(feePayer);
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return jsonResponse({ transaction: b64, mintPublicKey: mint.publicKey.toBase58() });
  }) as typeof fetch;
  return { fetchImpl, bodies, mint };
}

const chain = (balance: number): FakeChain => ({ balance, simErr: null, sent: [], simulated: 0 });

describe("coin deployer", () => {
  it("dry run: builds, signs, simulates - and sends nothing", async () => {
    const c = chain(1_000_000_000);
    const api = pumpApi();
    const r = await deployCoin(testConfig(), fakeRpc(c), wallet, params, api.fetchImpl);
    expect(r).toMatchObject({ dryRun: true, simulated: true, unitsConsumed: 123_000, mint: api.mint.publicKey.toBase58() });
    expect(c.simulated).toBe(1);
    expect(c.sent).toHaveLength(0);
    expect(api.bodies[0]).toMatchObject({ user: wallet.publicKey.toBase58(), symbol: "CROAK", solLamports: "50000000", encoding: "base64" });
  });

  it("live: sends a tx signed by both the mint and our wallet", async () => {
    const c = chain(1_000_000_000);
    const api = pumpApi();
    const r = await deployCoin(testConfig({ DRY_RUN: "false", SIGNER_PRIVATE_KEY: "x", PINATA_JWT: "j", SOLANA_RPC_URL: "https://rpc.test" }), fakeRpc(c), wallet, params, api.fetchImpl);
    expect(r).toMatchObject({ dryRun: false, signature: "SIG1" });
    const sent = VersionedTransaction.deserialize(c.sent[0]!);
    expect(sent.signatures.every((s) => s.some((b) => b !== 0))).toBe(true);
  });

  it("fails safely when funds are low (before calling pump.fun)", async () => {
    const api = pumpApi();
    // 0.1 SOL < 0.05 buy + 0.03 buffer + 0.05 reserve
    await expect(deployCoin(testConfig(), fakeRpc(chain(100_000_000)), wallet, params, api.fetchImpl)).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(api.bodies).toHaveLength(0);
  });

  it("refuses to sign a transaction paid by someone else", async () => {
    const api = pumpApi(Keypair.generate().publicKey);
    await expect(deployCoin(testConfig(), fakeRpc(chain(1_000_000_000)), wallet, params, api.fetchImpl)).rejects.toThrow(/refusing to sign/);
  });

  it("stops on simulation failure and never sends", async () => {
    const c = { ...chain(1_000_000_000), simErr: { InstructionError: [0, "Custom"] } };
    const api = pumpApi();
    await expect(
      deployCoin(testConfig({ DRY_RUN: "false", SIGNER_PRIVATE_KEY: "x", PINATA_JWT: "j", SOLANA_RPC_URL: "https://rpc.test" }), fakeRpc(c), wallet, params, api.fetchImpl),
    ).rejects.toThrow(/simulation failed/);
    expect(c.sent).toHaveLength(0);
  });

  it("dry run without a wallet just logs the request", async () => {
    const r = await deployCoin(testConfig(), undefined, undefined, params);
    expect(r).toMatchObject({ dryRun: true, simulated: false });
  });
});

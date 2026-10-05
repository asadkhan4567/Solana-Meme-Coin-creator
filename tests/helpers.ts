import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import bs58 from "bs58";
import { loadConfig, type Config } from "../src/config.js";
import type { RpcRunner } from "../src/coinDeployer.js";
import type { ImageProvider } from "../src/lib/imageGen.js";
import type { LlmClient } from "../src/lib/llm.js";

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "meme-agent-"));
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  const dir = tmpDir();
  return loadConfig({
    OPENAI_API_KEY: "sk-test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    DATA_DIR: path.join(dir, "data"),
    OUT_DIR: path.join(dir, "out"),
    ...overrides,
  });
}

/** A pump.fun-like create tx: fee payer = wallet, partial-signed by a fresh mint keypair. */
export function fakeCreateTx(feePayer: PublicKey): { b64: string; mint: Keypair } {
  const mint = Keypair.generate();
  const msg = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: bs58.encode(Buffer.alloc(32, 7)),
    instructions: [
      SystemProgram.createAccount({
        fromPubkey: feePayer,
        newAccountPubkey: mint.publicKey,
        lamports: 1_000_000,
        space: 82,
        programId: SystemProgram.programId,
      }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([mint]);
  return { b64: Buffer.from(tx.serialize()).toString("base64"), mint };
}

export interface FakeChain {
  balance: number;
  simErr: unknown;
  sent: Uint8Array[];
  simulated: number;
}

export function fakeRpc(chain: FakeChain): RpcRunner {
  const conn = {
    getBalance: async () => chain.balance,
    simulateTransaction: async () => {
      chain.simulated++;
      return { context: { slot: 1 }, value: { err: chain.simErr, logs: ["log"], unitsConsumed: 123_000, accounts: [{ lamports: chain.balance }] } };
    },
    getLatestBlockhash: async () => ({ blockhash: bs58.encode(Buffer.alloc(32, 7)), lastValidBlockHeight: 100 }),
    sendRawTransaction: async (raw: Uint8Array) => {
      chain.sent.push(raw);
      return "SIG" + chain.sent.length;
    },
    confirmTransaction: async () => ({ context: { slot: 2 }, value: { err: null } }),
  } as unknown as Connection;
  return { call: (_label, fn) => fn(conn) };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Fake LLM: answers concept prompts with `concept`, judge prompts with `scores`. */
export function fakeLlm(name: string, concept: object, scores: number[] | ((n: number) => number[])): LlmClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    name,
    calls,
    async json(system: string, user: string) {
      calls.push(system.slice(0, 30));
      if (/judge/i.test(system)) {
        const n = (user.match(/^\d+\./gm)?.length ?? 0) || Number(user.match(/Score the (\d+) images/)?.[1] ?? 2);
        return { scores: typeof scores === "function" ? scores(n) : scores };
      }
      return concept;
    },
  };
}

export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

export function fakeImage(name: string, fail = false): ImageProvider {
  return {
    name,
    async generate() {
      if (fail) throw new Error(`${name} down`);
      return PNG;
    },
  };
}

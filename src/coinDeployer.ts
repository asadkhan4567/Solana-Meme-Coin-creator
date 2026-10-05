import {
  TransactionExpiredBlockheightExceededError,
  VersionedTransaction,
  type Connection,
  type Keypair,
} from "@solana/web3.js";
import { lamportsToSol, type Config } from "./config.js";
import { requiredLamports, type LimitConfig } from "./guards.js";
import { log } from "./logger.js";
import { sendTransactionToJito } from "./lib/jito.js";
import { httpJson, NonRetryableError } from "./lib/retry.js";

/** Anything that can run a function against a Connection (RpcPool, or a fake in tests). */
export interface RpcRunner {
  call<T>(label: string, fn: (c: Connection) => Promise<T>): Promise<T>;
}

export class InsufficientFundsError extends NonRetryableError {
  constructor(readonly balance: bigint, readonly required: bigint) {
    super(
      `Insufficient funds: wallet has ${lamportsToSol(balance)} SOL, needs ${lamportsToSol(required)} SOL ` +
        "(initial buy + fees/rent buffer + reserve). Top up the wallet or lower INITIAL_BUY_*_SOL.",
    );
    this.name = "InsufficientFundsError";
  }
}

export interface DeployParams {
  name: string;
  symbol: string;
  uri: string;
  initialBuyLamports: bigint;
}

export interface DeployResult {
  dryRun: boolean;
  mint: string;
  signature?: string;
  simulated: boolean;
  unitsConsumed?: number;
  requestBody: Record<string, unknown>;
}

interface CreateCoinResponse {
  transaction: string;
  mintPublicKey: string;
}

export type DeployConfig = Pick<
  Config,
  "DRY_RUN" | "PUMP_API_BASE" | "FRONT_RUNNING_PROTECTION" | "JITO_TIP_SOL" | "MAYHEM_MODE" | "CASHBACK"
> &
  LimitConfig;

export function createCoinRequest(cfg: DeployConfig, creator: string, p: DeployParams): Record<string, unknown> {
  return {
    user: creator,
    creator,
    feePayer: creator,
    name: p.name,
    symbol: p.symbol,
    uri: p.uri,
    solLamports: p.initialBuyLamports.toString(),
    mayhemMode: cfg.MAYHEM_MODE,
    cashback: cfg.CASHBACK,
    tokenizedAgent: false,
    frontRunningProtection: cfg.FRONT_RUNNING_PROTECTION,
    tipAmount: cfg.FRONT_RUNNING_PROTECTION ? cfg.JITO_TIP_SOL : 0,
    encoding: "base64", // the API defaults to base58; we always use base64 end to end
  };
}

export async function assertFunds(rpc: RpcRunner, wallet: Keypair, needed: bigint): Promise<bigint> {
  const balance = BigInt(await rpc.call("getBalance", (c) => c.getBalance(wallet.publicKey, "confirmed")));
  if (balance < needed) throw new InsufficientFundsError(balance, needed);
  return balance;
}

/** Ask pump.fun to build the create+buy tx (already partial-signed by the new mint), then sign it ourselves. */
export async function buildSignedCreateTx(
  cfg: DeployConfig,
  wallet: Keypair,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ tx: VersionedTransaction; mint: string }> {
  const res = await httpJson<CreateCoinResponse>(
    `${cfg.PUMP_API_BASE.replace(/\/+$/, "")}/agents/create-coin`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    { fetchImpl, label: "pump.fun create-coin" },
  );
  if (!res?.transaction || !res.mintPublicKey) throw new NonRetryableError("pump.fun API returned no transaction");

  const tx = VersionedTransaction.deserialize(Buffer.from(res.transaction, "base64"));
  // Safety: only ever sign a transaction where WE are the fee payer we asked for.
  const feePayer = tx.message.staticAccountKeys[0];
  if (!feePayer?.equals(wallet.publicKey)) {
    throw new NonRetryableError(`refusing to sign: tx fee payer ${feePayer?.toBase58()} is not our wallet`);
  }
  tx.sign([wallet]);
  return { tx, mint: res.mintPublicKey };
}

async function simulate(rpc: RpcRunner, tx: VersionedTransaction): Promise<number | undefined> {
  const sim = await rpc.call("simulateTransaction", (c) =>
    c.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" }),
  );
  if (sim.value.err) {
    const logs = (sim.value.logs ?? []).slice(-8).join(" | ");
    throw new NonRetryableError(`simulation failed: ${JSON.stringify(sim.value.err)} ${logs}`);
  }
  return sim.value.unitsConsumed;
}

async function sendAndConfirm(cfg: DeployConfig, rpc: RpcRunner, tx: VersionedTransaction): Promise<string> {
  const raw = tx.serialize();
  const { blockhash, lastValidBlockHeight } = await rpc.call("getLatestBlockhash", (c) => c.getLatestBlockhash("confirmed"));
  let signature: string;
  if (cfg.FRONT_RUNNING_PROTECTION) {
    // Must go ONLY to Jito, otherwise the tx leaks to the public mempool.
    signature = await sendTransactionToJito(Buffer.from(raw).toString("base64"));
  } else {
    signature = await rpc.call("sendRawTransaction", (c) =>
      c.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 5 }),
    );
  }
  log.info("transaction sent", { signature });
  // Re-sending or re-confirming the SAME signed tx is safe: it has one signature and can land only once.
  const conf = await rpc.call("confirmTransaction", (c) =>
    c.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash ?? blockhash, lastValidBlockHeight }, "confirmed"),
  );
  if (conf.value.err) throw new NonRetryableError(`transaction failed on chain: ${JSON.stringify(conf.value.err)}`);
  return signature;
}

/**
 * Full deploy: funds check -> build via pump.fun API -> verify + sign -> simulate -> send -> confirm.
 * DRY_RUN stops after simulation (needs a wallet) or after building the request (no wallet).
 * Self-healing: if the tx expires before landing it is rebuilt with a fresh blockhash (max 2 rebuilds);
 * an expired tx can never land later, so this cannot create two coins.
 */
export async function deployCoin(
  cfg: DeployConfig,
  rpc: RpcRunner | undefined,
  wallet: Keypair | undefined,
  params: DeployParams,
  fetchImpl: typeof fetch = fetch,
): Promise<DeployResult> {
  if (params.initialBuyLamports <= 0n) throw new NonRetryableError("initial buy must be > 0");
  const creator = wallet?.publicKey.toBase58() ?? "<no wallet configured>";
  const requestBody = createCoinRequest(cfg, creator, params);

  if (!wallet || !rpc) {
    if (!cfg.DRY_RUN) throw new NonRetryableError("live mode needs SIGNER_PRIVATE_KEY and an RPC");
    log.info("dry run: no wallet, logging request only", { requestBody });
    return { dryRun: true, mint: "(not built)", simulated: false, requestBody };
  }

  const balance = await assertFunds(rpc, wallet, requiredLamports(params.initialBuyLamports, cfg));
  log.info("funds ok", { balanceSol: lamportsToSol(balance), initialBuySol: lamportsToSol(params.initialBuyLamports) });

  for (let attempt = 0; attempt < 3; attempt++) {
    const { tx, mint } = await buildSignedCreateTx(cfg, wallet, requestBody, fetchImpl);
    const unitsConsumed = await simulate(rpc, tx);

    if (cfg.DRY_RUN) {
      log.info("dry run: simulated OK, NOT sending", { mint, unitsConsumed, requestBody });
      return { dryRun: true, mint, simulated: true, unitsConsumed, requestBody };
    }
    try {
      const signature = await sendAndConfirm(cfg, rpc, tx);
      return { dryRun: false, mint, signature, simulated: true, unitsConsumed, requestBody };
    } catch (err) {
      if (err instanceof TransactionExpiredBlockheightExceededError && attempt < 2) {
        log.warn("transaction expired before landing, rebuilding", { attempt: attempt + 1, mint });
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

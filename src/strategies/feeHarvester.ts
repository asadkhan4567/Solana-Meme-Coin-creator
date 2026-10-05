import { VersionedTransaction, type Keypair } from "@solana/web3.js";
import type { RpcRunner } from "../coinDeployer.js";
import { lamportsToSol, solToLamports, type Config } from "../config.js";
import { log } from "../logger.js";
import { notify } from "../notify.js";
import { httpJson } from "../lib/retry.js";
import type { Store } from "../store.js";

/**
 * Strategy: harvest creator fees.
 * pump.fun pays the creator a share of every trade on their coins. This is the agent's
 * steady, legitimate income: it never needs anyone else to lose for it to earn.
 * For each live coin we build the collect tx, simulate it to see the NET gain after the tx fee,
 * and only send when that beats FEE_COLLECT_MIN_SOL.
 */
export async function harvestFees(
  cfg: Pick<Config, "PUMP_API_BASE" | "FEE_COLLECT_MIN_SOL" | "FEE_COLLECT_INTERVAL_MIN" | "DRY_RUN" | "NOTIFY_WEBHOOK_URL">,
  store: Store,
  rpc: RpcRunner,
  wallet: Keypair,
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<{ checked: number; collectedLamports: bigint }> {
  const minGain = solToLamports(cfg.FEE_COLLECT_MIN_SOL);
  let checked = 0;
  let collected = 0n;

  for (const launch of store.liveLaunches()) {
    const last = launch.lastFeeCollectAt ? Date.parse(launch.lastFeeCollectAt) : 0;
    if (now.getTime() - last < cfg.FEE_COLLECT_INTERVAL_MIN * 60_000) continue;
    checked++;
    try {
      const res = await httpJson<{ transaction: string }>(
        `${cfg.PUMP_API_BASE.replace(/\/+$/, "")}/agents/collect-fees`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mint: launch.mint, user: wallet.publicKey.toBase58(), encoding: "base64" }),
        },
        { fetchImpl, label: "pump.fun collect-fees", retries: 2 },
      );
      const tx = VersionedTransaction.deserialize(Buffer.from(res.transaction, "base64"));
      if (!tx.message.staticAccountKeys[0]?.equals(wallet.publicKey)) throw new Error("fee tx payer is not our wallet");
      tx.sign([wallet]);

      const pre = BigInt(await rpc.call("getBalance", (c) => c.getBalance(wallet.publicKey, "confirmed")));
      const sim = await rpc.call("simulateCollect", (c) =>
        c.simulateTransaction(tx, {
          sigVerify: false,
          commitment: "confirmed",
          accounts: { encoding: "base64", addresses: [wallet.publicKey.toBase58()] },
        }),
      );
      launch.lastFeeCollectAt = now.toISOString();
      if (sim.value.err) {
        log.info("no fees to collect", { mint: launch.mint, err: JSON.stringify(sim.value.err) });
        continue;
      }
      const post = BigInt(sim.value.accounts?.[0]?.lamports ?? 0);
      const gain = post - pre;
      if (gain < minGain) {
        log.info("fees below threshold", { mint: launch.mint, gainSol: lamportsToSol(gain) });
        continue;
      }
      if (cfg.DRY_RUN) {
        log.info("dry run: would collect fees", { mint: launch.mint, gainSol: lamportsToSol(gain) });
        continue;
      }
      const raw = tx.serialize();
      const signature = await rpc.call("sendCollect", (c) => c.sendRawTransaction(raw, { maxRetries: 5 }));
      const bh = await rpc.call("getLatestBlockhash", (c) => c.getLatestBlockhash("confirmed"));
      await rpc.call("confirmCollect", (c) =>
        c.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed"),
      );
      launch.feesCollectedLamports = (BigInt(launch.feesCollectedLamports) + gain).toString();
      collected += gain;
      log.info("fees collected", { mint: launch.mint, gainSol: lamportsToSol(gain), signature });
    } catch (err) {
      log.warn("fee collection failed", { mint: launch.mint, error: String(err) });
    } finally {
      store.save();
    }
  }
  store.state.lastFeeRunAt = now.toISOString();
  store.save();
  if (collected > 0n) await notify(cfg, "fees_collected", { sol: lamportsToSol(collected) });
  return { checked, collectedLamports: collected };
}

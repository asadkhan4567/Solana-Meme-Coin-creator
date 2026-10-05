import fs from "node:fs";
import path from "node:path";
import type { Keypair } from "@solana/web3.js";
import { deployCoin, InsufficientFundsError, type RpcRunner } from "./coinDeployer.js";
import { lamportsToSol, type Config } from "./config.js";
import { runCreativeDirector, type CreativeResult } from "./creativeDirector.js";
import { canLaunch, dailyStats, sizeInitialBuy } from "./guards.js";
import { log } from "./logger.js";
import { uploadMetadata, buildMetadata } from "./metadataUploader.js";
import { notify } from "./notify.js";
import type { ImageProvider } from "./lib/imageGen.js";
import type { LlmClient } from "./lib/llm.js";
import { harvestFees } from "./strategies/feeHarvester.js";
import { trackPerformance } from "./strategies/performanceTracker.js";
import type { Store } from "./store.js";
import { pickTrend, scanTrends, type Trend } from "./trendScanner.js";

export interface AgentDeps {
  cfg: Config;
  store: Store;
  llms: LlmClient[];
  images: ImageProvider[];
  rpc?: RpcRunner;
  wallet?: Keypair;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Override for tests. */
  scan?: () => Promise<Trend[]>;
}

export type CycleStatus = "launched" | "dry_run" | "skipped" | "failed";

export interface CycleResult {
  runId: string;
  status: CycleStatus;
  reason?: string;
  trend?: Trend;
  name?: string;
  ticker?: string;
  mint?: string;
  signature?: string;
  initialBuySol?: number;
  outDir?: string;
}

const runIdFor = (d: Date) => d.toISOString().replace(/[:.]/g, "-");

/** Housekeeping that must never block a launch: learn from past coins, harvest fees. */
async function maintenance(deps: AgentDeps, now: Date): Promise<void> {
  const { cfg, store, rpc, wallet, fetchImpl } = deps;
  try {
    await trackPerformance(cfg, store, now, fetchImpl);
  } catch (err) {
    log.warn("performance tracking failed", { error: String(err) });
  }
  if (rpc && wallet) {
    try {
      await harvestFees(cfg, store, rpc, wallet, now, fetchImpl);
    } catch (err) {
      log.warn("fee harvest failed", { error: String(err) });
    }
  }
}

/**
 * One full cycle: maintenance -> gates -> trend -> creative contest -> IPFS -> size -> deploy -> record.
 * Never throws; failures come back as status "failed" so the scheduler can back off.
 */
export async function runCycle(deps: AgentDeps): Promise<CycleResult> {
  const { cfg, store } = deps;
  const now = deps.now?.() ?? new Date();
  const runId = runIdFor(now);
  const outDir = path.resolve(cfg.OUT_DIR, runId);

  await maintenance(deps, now);

  const gate = canLaunch(cfg, store.state, now);
  if (!gate.ok) {
    log.info("cycle skipped", { reason: gate.reason });
    return { runId, status: "skipped", reason: gate.reason };
  }

  let trend: Trend | undefined;
  let creative: CreativeResult | undefined;
  try {
    const trends = await (deps.scan ?? (() => scanTrends(cfg, deps.fetchImpl)))();
    trend = pickTrend(trends, store.state, cfg, now);
    if (!trend) {
      const reason = `no fresh trend above MIN_TREND_SCORE=${cfg.MIN_TREND_SCORE}`;
      log.info("cycle skipped", { reason, best: trends[0] && `${trends[0].theme}:${trends[0].score.toFixed(2)}` });
      return { runId, status: "skipped", reason };
    }
    log.info("trend picked", { theme: trend.theme, score: trend.score, sources: trend.sources });

    creative = await runCreativeDirector(trend, deps.llms, deps.images, outDir, cfg.BLOCKED_TERMS);
    const { concept } = creative;

    const uploaded =
      cfg.DRY_RUN && !cfg.DRY_RUN_UPLOAD
        ? { imageUri: "ipfs://dry-run-image", metadataUri: "https://ipfs.io/ipfs/dry-run-metadata", metadata: buildMetadata(concept, "ipfs://dry-run-image") }
        : await uploadMetadata(cfg, concept, creative.logoFile, deps.fetchImpl);
    fs.writeFileSync(path.join(outDir, "metadata.json"), JSON.stringify(uploaded.metadata, null, 2));

    const initialBuy = sizeInitialBuy(trend.score, cfg, dailyStats(store.state, now).spentLamports);
    const deploy = await deployCoin(
      cfg,
      deps.rpc,
      deps.wallet,
      { name: concept.name, symbol: concept.ticker, uri: uploaded.metadataUri, initialBuyLamports: initialBuy },
      deps.fetchImpl,
    );

    store.addLaunch({
      id: runId,
      createdAt: now.toISOString(),
      dryRun: deploy.dryRun,
      theme: trend.theme,
      trendScore: trend.score,
      sources: trend.sources,
      name: concept.name,
      ticker: concept.ticker,
      llmWinner: creative.llmWinner,
      imageWinner: creative.imageWinner,
      metadataUri: uploaded.metadataUri,
      initialBuyLamports: initialBuy.toString(),
      ...(deploy.dryRun ? {} : { mint: deploy.mint, signature: deploy.signature }),
      snapshots: [],
      outcome: "pending",
      feesCollectedLamports: "0",
    });

    const result: CycleResult = {
      runId,
      status: deploy.dryRun ? "dry_run" : "launched",
      trend,
      name: concept.name,
      ticker: concept.ticker,
      mint: deploy.mint,
      ...(deploy.signature ? { signature: deploy.signature } : {}),
      initialBuySol: lamportsToSol(initialBuy),
      outDir,
    };
    fs.writeFileSync(
      path.join(outDir, "summary.json"),
      JSON.stringify({ ...result, creative: { concepts: creative.concepts, logos: creative.logos }, deploy }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
    );
    await notify(cfg, deploy.dryRun ? "dry_run" : "launch", {
      name: concept.name,
      ticker: concept.ticker,
      description: concept.description,
      twitterHook: concept.twitterHook,
      theme: trend.theme,
      mint: deploy.dryRun ? undefined : deploy.mint,
      pumpUrl: deploy.dryRun ? undefined : `https://pump.fun/coin/${deploy.mint}`,
      initialBuySol: lamportsToSol(initialBuy),
      llmWinner: creative.llmWinner,
      imageWinner: creative.imageWinner,
    });
    log.info(deploy.dryRun ? "dry run complete" : "COIN LAUNCHED", { ...result, trend: trend.theme });
    return result;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error("cycle failed", { error: reason, theme: trend?.theme, ticker: creative?.concept.ticker });
    await notify(cfg, "error", { reason, theme: trend?.theme, insufficientFunds: err instanceof InsufficientFundsError });
    return { runId, status: "failed", reason, ...(trend ? { trend } : {}), ...(fs.existsSync(outDir) ? { outDir } : {}) };
  }
}

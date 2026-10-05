import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentDeps } from "./agent.js";
import { lamportsToSol } from "./config.js";
import { deployCoin, InsufficientFundsError } from "./coinDeployer.js";
import { canLaunch, checkNameAllowed, dailyStats, sizeInitialBuy } from "./guards.js";
import { httpBytes } from "./lib/retry.js";
import { log } from "./logger.js";
import { notify } from "./notify.js";

/**
 * A coin prepared elsewhere (the n8n pipeline: trends -> AI writers/judge -> logo -> IPFS).
 * The bot only does what must stay on this machine: enforce limits, sign and send the transaction.
 */
export const externalLaunchSchema = z.object({
  name: z.string().trim().min(2).max(32),
  ticker: z
    .string()
    .trim()
    .transform((t) => t.replace(/^\$/, "").toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{2,10}$/)),
  description: z.string().trim().min(10).max(400),
  metadataUri: z.string().trim().regex(/^(https:\/\/|ipfs:\/\/)\S+$/, "metadataUri must be https:// or ipfs://"),
  imageUri: z.string().trim().regex(/^(https:\/\/|ipfs:\/\/)\S+$/).optional(),
  logoUrl: z.string().trim().url().optional(), // http(s) copy of the logo, saved locally for the dashboard
  theme: z.string().trim().min(1).max(60),
  trendScore: z.coerce.number().min(0).max(1),
  sources: z.array(z.string()).max(10).default(["n8n"]),
  llmWinner: z.string().trim().max(40).default("n8n"),
  imageWinner: z.string().trim().max(40).default("n8n"),
});
export type ExternalLaunch = z.infer<typeof externalLaunchSchema>;

export type ExternalLaunchResult =
  | { status: "invalid"; reason: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string; runId: string }
  | { status: "dry_run" | "launched"; runId: string; name: string; ticker: string; mint: string; initialBuySol: number; pumpUrl?: string };

let busy = false;

const ipfsToHttp = (uri: string) => uri.replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/");

export async function runExternalLaunch(deps: AgentDeps, body: unknown): Promise<ExternalLaunchResult | { status: "busy" }> {
  const parsed = externalLaunchSchema.safeParse(body);
  if (!parsed.success) {
    return { status: "invalid", reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const input = parsed.data;
  const { cfg, store } = deps;

  const allowed = checkNameAllowed(input.name, input.ticker, cfg.BLOCKED_TERMS);
  if (!allowed.ok) return { status: "invalid", reason: allowed.reason ?? "name not allowed" };

  if (busy) return { status: "busy" };
  busy = true;
  const now = deps.now?.() ?? new Date();
  const runId = `n8n-${now.toISOString().replace(/[:.]/g, "-")}`;
  try {
    const gate = canLaunch(cfg, store.state, now);
    if (!gate.ok) return { status: "skipped", reason: gate.reason ?? "limits reached" };
    if (store.state.launches.some((l) => l.ticker === input.ticker && l.theme === input.theme)) {
      return { status: "skipped", reason: `already launched ${input.ticker} for theme "${input.theme}"` };
    }

    const outDir = path.resolve(cfg.OUT_DIR, runId);
    fs.mkdirSync(outDir, { recursive: true });
    // Best effort: keep a local copy of the logo so the dashboard can show it.
    const logoSrc = input.logoUrl ?? (input.imageUri ? ipfsToHttp(input.imageUri) : undefined);
    if (logoSrc) {
      try {
        const bytes = await httpBytes(logoSrc, { fetchImpl: deps.fetchImpl });
        fs.writeFileSync(path.join(outDir, `logo-${input.imageWinner.replace(/[^\w-]/g, "")}.jpg`), bytes);
      } catch (err) {
        log.warn("could not save logo copy", { error: String(err) });
      }
    }

    const initialBuy = sizeInitialBuy(input.trendScore, cfg, dailyStats(store.state, now).spentLamports);
    const deploy = await deployCoin(
      cfg,
      deps.rpc,
      deps.wallet,
      { name: input.name, symbol: input.ticker, uri: input.metadataUri, initialBuyLamports: initialBuy },
      deps.fetchImpl,
    );

    store.addLaunch({
      id: runId,
      createdAt: now.toISOString(),
      dryRun: deploy.dryRun,
      theme: input.theme,
      trendScore: input.trendScore,
      sources: input.sources,
      name: input.name,
      ticker: input.ticker,
      llmWinner: input.llmWinner,
      imageWinner: input.imageWinner,
      metadataUri: input.metadataUri,
      ...(input.imageUri ? { imageUri: ipfsToHttp(input.imageUri) } : {}),
      initialBuyLamports: initialBuy.toString(),
      ...(deploy.dryRun ? {} : { mint: deploy.mint, signature: deploy.signature }),
      snapshots: [],
      outcome: "pending",
      feesCollectedLamports: "0",
    });

    const pumpUrl = deploy.dryRun ? undefined : `https://pump.fun/coin/${deploy.mint}`;
    const result: ExternalLaunchResult = {
      status: deploy.dryRun ? "dry_run" : "launched",
      runId,
      name: input.name,
      ticker: input.ticker,
      mint: deploy.mint,
      initialBuySol: lamportsToSol(initialBuy),
      ...(pumpUrl ? { pumpUrl } : {}),
    };
    fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ ...result, input }, null, 2));
    log.info(deploy.dryRun ? "n8n dry run complete" : "COIN LAUNCHED (n8n)", { ...result });
    await notify(cfg, deploy.dryRun ? "dry_run" : "launch", { ...result, theme: input.theme, description: input.description });
    return result;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error("n8n launch failed", { error: reason, ticker: input.ticker });
    await notify(cfg, "error", { reason, ticker: input.ticker, insufficientFunds: err instanceof InsufficientFundsError });
    return { status: "failed", reason, runId };
  } finally {
    busy = false;
  }
}

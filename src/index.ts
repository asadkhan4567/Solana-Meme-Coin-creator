import "dotenv/config";
import http from "node:http";
import { runCycle, type AgentDeps, type CycleResult } from "./agent.js";
import { lamportsToSol, loadConfig, type Config } from "./config.js";
import { log, setLogLevel } from "./logger.js";
import { notify } from "./notify.js";
import { buildImageProviders } from "./lib/imageGen.js";
import { buildLlms } from "./lib/llm.js";
import { RpcPool } from "./lib/rpc.js";
import { loadKeypair } from "./lib/wallet.js";
import { harvestFees } from "./strategies/feeHarvester.js";
import { Store } from "./store.js";

export function bootstrap(cfg: Config): AgentDeps {
  const wallet = loadKeypair(cfg.SIGNER_PRIVATE_KEY);
  const rpc = new RpcPool([cfg.SOLANA_RPC_URL, ...cfg.SOLANA_RPC_URLS_FALLBACK]);
  return {
    cfg,
    store: new Store(cfg.DATA_DIR),
    llms: buildLlms(cfg),
    images: buildImageProviders(cfg),
    rpc,
    ...(wallet ? { wallet } : {}),
  };
}

/**
 * Self-healing scheduler: runs a cycle every CYCLE_INTERVAL_MIN; after failures it backs off
 * exponentially (max 6h) and alerts; the first success after failures sends a "recovered" alert.
 */
export class Scheduler {
  busy = false;
  consecutiveFailures = 0;
  lastResult?: CycleResult;
  lastRunAt?: string;
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: AgentDeps) {}

  async runOnce(): Promise<CycleResult | { status: "busy" }> {
    if (this.busy) return { status: "busy" };
    this.busy = true;
    try {
      const result = await runCycle(this.deps);
      this.lastResult = result;
      this.lastRunAt = new Date().toISOString();
      if (result.status === "failed") {
        this.consecutiveFailures++;
      } else {
        if (this.consecutiveFailures > 0) await notify(this.deps.cfg, "recovered", { after: this.consecutiveFailures });
        this.consecutiveFailures = 0;
      }
      return result;
    } catch (err) {
      // runCycle should never throw; this is the last line of defence.
      this.consecutiveFailures++;
      log.error("unexpected cycle crash", { error: String(err) });
      return { runId: "crash", status: "failed", reason: String(err) };
    } finally {
      this.busy = false;
    }
  }

  nextDelayMs(): number {
    const base = this.deps.cfg.CYCLE_INTERVAL_MIN * 60_000;
    return Math.min(6 * 3_600_000, base * 2 ** Math.min(this.consecutiveFailures, 6));
  }

  start(): void {
    if (this.deps.cfg.CYCLE_INTERVAL_MIN <= 0) {
      log.info("internal schedule disabled (CYCLE_INTERVAL_MIN=0); waiting for POST /run (e.g. from n8n)");
      return;
    }
    const tick = async () => {
      await this.runOnce();
      const delay = this.nextDelayMs();
      log.info("next cycle scheduled", { inMinutes: Math.round(delay / 60_000), consecutiveFailures: this.consecutiveFailures });
      this.timer = setTimeout(tick, delay);
    };
    this.timer = setTimeout(tick, 5_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}

function authorized(req: http.IncomingMessage, cfg: Config): boolean {
  return Boolean(cfg.AGENT_API_TOKEN) && req.headers.authorization === `Bearer ${cfg.AGENT_API_TOKEN}`;
}

const sendJson = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
};

/** Tiny control API so n8n (or you) can trigger runs and watch health. */
export function startServer(deps: AgentDeps, scheduler: Scheduler): http.Server {
  const { cfg, store } = deps;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") {
        const balance = deps.wallet && deps.rpc
          ? await deps.rpc.call("getBalance", (c) => c.getBalance(deps.wallet!.publicKey)).catch(() => null)
          : null;
        return sendJson(res, 200, {
          ok: scheduler.consecutiveFailures < 3,
          dryRun: cfg.DRY_RUN,
          wallet: deps.wallet?.publicKey.toBase58() ?? null,
          balanceSol: balance === null ? null : lamportsToSol(balance),
          lastRunAt: scheduler.lastRunAt ?? null,
          lastStatus: scheduler.lastResult?.status ?? null,
          consecutiveFailures: scheduler.consecutiveFailures,
          pausedUntil: store.state.pausedUntil ?? null,
          launches: store.liveLaunches().length,
        });
      }
      if (req.method === "GET" && url.pathname === "/launches") {
        if (!authorized(req, cfg)) return sendJson(res, 401, { error: "unauthorized" });
        return sendJson(res, 200, store.state.launches.slice(-50));
      }
      if (req.method === "POST" && url.pathname === "/run") {
        if (!authorized(req, cfg)) return sendJson(res, 401, { error: "unauthorized" });
        const result = await scheduler.runOnce();
        return sendJson(res, result.status === "busy" ? 409 : 200, result);
      }
      if (req.method === "POST" && url.pathname === "/collect-fees") {
        if (!authorized(req, cfg)) return sendJson(res, 401, { error: "unauthorized" });
        if (!deps.wallet || !deps.rpc) return sendJson(res, 400, { error: "no wallet configured" });
        const r = await harvestFees(cfg, store, deps.rpc, deps.wallet);
        return sendJson(res, 200, { checked: r.checked, collectedSol: lamportsToSol(r.collectedLamports) });
      }
      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      log.error("http handler error", { error: String(err) });
      sendJson(res, 500, { error: "internal error" });
    }
  });
  server.listen(cfg.PORT, () => log.info("control API listening", { port: cfg.PORT }));
  return server;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.LOG_LEVEL);
  const deps = bootstrap(cfg);
  log.info("agent starting", {
    dryRun: cfg.DRY_RUN,
    wallet: deps.wallet?.publicKey.toBase58() ?? null,
    llms: deps.llms.map((l) => l.name),
    images: deps.images.map((i) => i.name),
  });

  const args = process.argv.slice(2);
  if (args.includes("--once")) {
    const r = await runCycle(deps);
    process.exitCode = r.status === "failed" ? 1 : 0;
    return;
  }
  if (args.includes("--collect-fees")) {
    if (!deps.wallet || !deps.rpc) throw new Error("SIGNER_PRIVATE_KEY is required to collect fees");
    const r = await harvestFees(cfg, deps.store, deps.rpc, deps.wallet);
    log.info("fee run done", { checked: r.checked, collectedSol: lamportsToSol(r.collectedLamports) });
    return;
  }

  const scheduler = new Scheduler(deps);
  const server = startServer(deps, scheduler);
  scheduler.start();

  process.on("unhandledRejection", (err) => log.error("unhandled rejection", { error: String(err) }));
  const shutdown = () => {
    log.info("shutting down");
    scheduler.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const isEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!);
if (isEntry) {
  main().catch((err) => {
    log.error("fatal", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}

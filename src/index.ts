import "dotenv/config";
import crypto from "node:crypto";
import http from "node:http";
import { runCycle, type AgentDeps, type CycleResult } from "./agent.js";
import { lamportsToSol, loadConfig, type Config } from "./config.js";
import { buildSummary, DASHBOARD_HTML } from "./dashboard.js";
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
  nextRunAt?: string;
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
      this.nextRunAt = new Date(Date.now() + delay).toISOString();
      this.timer = setTimeout(tick, delay);
    };
    this.timer = setTimeout(tick, 5_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Accepts `Authorization: Bearer <AGENT_API_TOKEN>` (n8n, scripts) or HTTP Basic with the token
 * as the password (any username) so the dashboard works with the browser's own login prompt.
 */
export function authorized(req: http.IncomingMessage, cfg: Pick<Config, "AGENT_API_TOKEN">): boolean {
  const token = cfg.AGENT_API_TOKEN;
  const header = req.headers.authorization ?? "";
  if (!token) return false;
  if (header.startsWith("Bearer ")) return safeEqual(header.slice(7), token);
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    return safeEqual(decoded.slice(decoded.indexOf(":") + 1), token);
  }
  return false;
}

const sendJson = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
};

async function walletBalanceSol(deps: AgentDeps): Promise<number | null> {
  if (!deps.wallet || !deps.rpc) return null;
  const lamports = await deps.rpc.call("getBalance", (c) => c.getBalance(deps.wallet!.publicKey)).catch(() => null);
  return lamports === null ? null : lamportsToSol(lamports);
}

/** Tiny control API + dashboard so n8n (or you) can trigger runs and watch results. */
export function createControlServer(deps: AgentDeps, scheduler: Scheduler): http.Server {
  const { cfg, store } = deps;
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
        if (!authorized(req, cfg)) {
          res.writeHead(401, { "WWW-Authenticate": 'Basic realm="meme-agent", charset="UTF-8"', "Content-Type": "text/plain" });
          return res.end(cfg.AGENT_API_TOKEN ? "Log in with any username and your AGENT_API_TOKEN as the password." : "Set AGENT_API_TOKEN to enable the dashboard.");
        }
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data:; connect-src 'self'",
          "X-Frame-Options": "DENY",
          "Cache-Control": "no-store",
        });
        return res.end(DASHBOARD_HTML);
      }
      if (req.method === "GET" && url.pathname === "/api/summary") {
        if (!authorized(req, cfg)) return sendJson(res, 401, { error: "unauthorized" });
        return sendJson(res, 200, buildSummary(store.state, {
          dryRun: cfg.DRY_RUN,
          wallet: deps.wallet?.publicKey.toBase58() ?? null,
          balanceSol: await walletBalanceSol(deps),
          status: {
            lastRunAt: scheduler.lastRunAt ?? null,
            lastStatus: scheduler.lastResult?.status ?? null,
            nextRunAt: scheduler.nextRunAt ?? null,
            consecutiveFailures: scheduler.consecutiveFailures,
          },
          settings: {
            launchHoursUtc: cfg.LAUNCH_HOURS_UTC || "any",
            cycleIntervalMin: cfg.CYCLE_INTERVAL_MIN,
            maxLaunchesPerDay: cfg.MAX_LAUNCHES_PER_DAY,
            maxDailySpendSol: cfg.MAX_DAILY_SPEND_SOL,
            initialBuyMinSol: cfg.INITIAL_BUY_MIN_SOL,
            initialBuyMaxSol: cfg.INITIAL_BUY_MAX_SOL,
            minTrendScore: cfg.MIN_TREND_SCORE,
            llms: deps.llms.map((l) => l.name),
            images: deps.images.map((i) => i.name),
          },
        }));
      }
      if (req.method === "GET" && url.pathname === "/health") {
        const balanceSol = await walletBalanceSol(deps);
        return sendJson(res, 200, {
          ok: scheduler.consecutiveFailures < 3,
          dryRun: cfg.DRY_RUN,
          wallet: deps.wallet?.publicKey.toBase58() ?? null,
          balanceSol,
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
}

export function startServer(deps: AgentDeps, scheduler: Scheduler): http.Server {
  const server = createControlServer(deps, scheduler);
  server.listen(deps.cfg.PORT, () => log.info("control API + dashboard listening", { port: deps.cfg.PORT, dashboard: "/dashboard" }));
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

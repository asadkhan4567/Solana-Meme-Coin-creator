import type { Config } from "./config.js";
import { log } from "./logger.js";

export type NotifyEvent =
  | "launch"
  | "dry_run"
  | "skipped"
  | "error"
  | "fees_collected"
  | "paused"
  | "recovered"
  | "outcome";

/**
 * Posts an event to NOTIFY_WEBHOOK_URL (e.g. an n8n Webhook node that forwards to
 * Telegram / Discord / X). Never throws: alerts must not break the agent.
 */
export async function notify(cfg: Pick<Config, "NOTIFY_WEBHOOK_URL">, event: NotifyEvent, data: object): Promise<void> {
  if (!cfg.NOTIFY_WEBHOOK_URL) return;
  try {
    const res = await fetch(cfg.NOTIFY_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, at: new Date().toISOString(), ...data }, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log.warn("notify webhook rejected", { event, status: res.status });
  } catch (err) {
    log.warn("notify webhook failed", { event, error: String(err) });
  }
}

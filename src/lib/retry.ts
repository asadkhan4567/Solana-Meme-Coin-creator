import { log } from "../logger.js";

/** An error that must not be retried (bad input, insufficient funds, simulation failure...). */
export class NonRetryableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "NonRetryableError";
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    // Telegram puts the bot token in the path: never let it reach logs.
    const where = `${new URL(url).host}${new URL(url).pathname.replace(/\/bot[^/]+/, "/bot[redacted]")}`;
    super(`HTTP ${status} from ${where}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  label?: string;
  sleep?: (ms: number) => Promise<void>;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function isRetryable(err: unknown): boolean {
  if (err instanceof NonRetryableError) return false;
  if (err instanceof HttpError) return err.retryable;
  return true; // network errors, timeouts, unknown failures
}

/** Exponential backoff with jitter. Non-retryable errors are rethrown immediately. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 3, baseMs = 500, maxMs = 8000, label = "operation", sleep: wait = sleep } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === retries) break;
      const delay = Math.min(maxMs, baseMs * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      log.warn("retrying", { label, attempt: attempt + 1, delayMs: Math.round(delay), error: String(err) });
      await wait(delay);
    }
  }
  throw lastErr;
}

export interface HttpOptions extends RetryOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** fetch + timeout + retry; parses JSON and throws HttpError on non-2xx. */
export async function httpJson<T = unknown>(url: string, init: RequestInit = {}, opts: HttpOptions = {}): Promise<T> {
  const { timeoutMs = 30_000, fetchImpl = fetch, ...retry } = opts;
  return withRetry(async () => {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, url, text);
    try {
      return (text ? JSON.parse(text) : null) as T;
    } catch {
      throw new HttpError(502, url, `invalid JSON: ${text.slice(0, 200)}`);
    }
  }, { label: retry.label ?? new URL(url).host, ...retry });
}

export async function httpBytes(url: string, opts: HttpOptions = {}): Promise<Buffer> {
  const { timeoutMs = 60_000, fetchImpl = fetch, ...retry } = opts;
  return withRetry(async () => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new HttpError(res.status, url, await res.text());
    return Buffer.from(await res.arrayBuffer());
  }, { label: retry.label ?? "download", ...retry });
}

/** JSON-lines logger. Values under secret-looking keys are always redacted. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const SECRET_KEY = /(private|secret|token|jwt|api_?key|password|authorization)/i;

let threshold: number = LEVELS.info;

export function setLogLevel(level: string): void {
  threshold = LEVELS[level as Level] ?? LEVELS.info;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== "object") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(redact(fields ?? {}) as object) });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => write("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write("error", msg, f),
};

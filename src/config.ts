import { z } from "zod";

/** Empty strings in .env mean "not set". */
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const str = () => z.preprocess(blankToUndefined, z.string().optional());
const strDefault = (def: string) => z.preprocess(blankToUndefined, z.string().default(def));
const num = (def: number) => z.preprocess(blankToUndefined, z.coerce.number().default(def));
const bool = (def: boolean) =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .optional()
      .transform((v) => (v === undefined ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase()))),
  );
const list = () =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .optional()
      .transform((v) =>
        (v ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
  );

const schema = z.object({
  // --- mode ---
  DRY_RUN: bool(true),
  DRY_RUN_UPLOAD: bool(false),

  // --- solana / pump.fun ---
  SOLANA_RPC_URL: strDefault("https://api.mainnet-beta.solana.com"),
  SOLANA_RPC_URLS_FALLBACK: list(),
  SIGNER_PRIVATE_KEY: str(),
  PUMP_API_BASE: strDefault("https://fun-block.pump.fun"),
  PUMP_COINS_API: strDefault("https://frontend-api-v3.pump.fun"),
  FRONT_RUNNING_PROTECTION: bool(false),
  JITO_TIP_SOL: num(0.0001),
  MAYHEM_MODE: bool(false),
  CASHBACK: bool(false),

  // --- trend sources ---
  X_API_BEARER_TOKEN: str(),
  X_SEARCH_QUERY: strDefault('(memecoin OR pumpfun OR "pump.fun" OR solana meme) -is:retweet lang:en'),
  DEXSCREENER_API_URL: strDefault("https://api.dexscreener.com"),

  // --- AI providers ---
  OPENAI_API_KEY: str(),
  OPENAI_MODEL: strDefault("gpt-4o"),
  OPENAI_IMAGE_MODEL: strDefault("dall-e-3"),
  ANTHROPIC_API_KEY: str(),
  ANTHROPIC_MODEL: strDefault("claude-opus-5-5"),
  FAL_KEY: str(),
  FLUX_MODEL: strDefault("fal-ai/flux/dev"),

  // --- IPFS ---
  PINATA_JWT: str(),
  IPFS_GATEWAY: strDefault("https://ipfs.io/ipfs/"),

  // --- strategy & risk limits ---
  MIN_TREND_SCORE: num(0.55),
  INITIAL_BUY_MIN_SOL: num(0.01),
  INITIAL_BUY_MAX_SOL: num(0.05),
  MAX_DAILY_SPEND_SOL: num(0.2),
  MAX_LAUNCHES_PER_DAY: num(3),
  MIN_WALLET_RESERVE_SOL: num(0.05),
  LAUNCH_COST_BUFFER_SOL: num(0.03),
  LAUNCH_HOURS_UTC: strDefault(""),
  THEME_COOLDOWN_HOURS: num(48),
  SUCCESS_MCAP_USD: num(15000),
  LOSS_STREAK_PAUSE: num(5),
  PAUSE_HOURS: num(24),
  FEE_COLLECT_MIN_SOL: num(0.002),
  FEE_COLLECT_INTERVAL_MIN: num(360),
  BLOCKED_TERMS: list(),

  // --- "don't copy" check ---
  TICKER_CHECK_ENABLED: bool(true),
  /** If both search APIs are down: false = skip that concept (safe), true = allow it. */
  TICKER_CHECK_FAIL_OPEN: bool(false),

  // --- auto-posting (live launches only) ---
  TELEGRAM_BOT_TOKEN: str(),
  TELEGRAM_CHANNEL_ID: str(),
  X_API_KEY: str(),
  X_API_SECRET: str(),
  X_ACCESS_TOKEN: str(),
  X_ACCESS_SECRET: str(),
  POST_DISCLAIMER: strDefault("Just a meme coin, no promises. Not financial advice - DYOR."),

  // --- runtime ---
  CYCLE_INTERVAL_MIN: num(60),
  PORT: num(8080),
  AGENT_API_TOKEN: str(),
  NOTIFY_WEBHOOK_URL: str(),
  DATA_DIR: strDefault("./data"),
  OUT_DIR: strDefault("./out"),
  LOG_LEVEL: strDefault("info"),
});

export type Config = z.infer<typeof schema>;

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  const problems: string[] = [];

  if (cfg.INITIAL_BUY_MIN_SOL <= 0) problems.push("INITIAL_BUY_MIN_SOL must be > 0");
  if (cfg.INITIAL_BUY_MAX_SOL < cfg.INITIAL_BUY_MIN_SOL)
    problems.push("INITIAL_BUY_MAX_SOL must be >= INITIAL_BUY_MIN_SOL");
  if (cfg.MAX_DAILY_SPEND_SOL < cfg.INITIAL_BUY_MIN_SOL)
    problems.push("MAX_DAILY_SPEND_SOL must be >= INITIAL_BUY_MIN_SOL");
  if (cfg.MIN_TREND_SCORE < 0 || cfg.MIN_TREND_SCORE >= 1) problems.push("MIN_TREND_SCORE must be in [0, 1)");
  if (!cfg.OPENAI_API_KEY && !cfg.ANTHROPIC_API_KEY)
    problems.push("set OPENAI_API_KEY and/or ANTHROPIC_API_KEY");
  if (!cfg.OPENAI_API_KEY && !cfg.FAL_KEY) problems.push("set OPENAI_API_KEY (DALL-E) and/or FAL_KEY (Flux)");

  if (!cfg.DRY_RUN) {
    if (!cfg.SIGNER_PRIVATE_KEY) problems.push("DRY_RUN=false requires SIGNER_PRIVATE_KEY");
    if (!cfg.PINATA_JWT) problems.push("DRY_RUN=false requires PINATA_JWT");
    if (cfg.SOLANA_RPC_URL.includes("api.mainnet-beta.solana.com"))
      problems.push("DRY_RUN=false needs a real RPC (the public mainnet RPC usually cannot send transactions)");
  }
  if (problems.length) throw new ConfigError(`Invalid configuration: ${problems.join("; ")}`);
  return cfg;
}

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const solToLamports = (sol: number): bigint => BigInt(Math.round(sol * LAMPORTS_PER_SOL));
export const lamportsToSol = (lamports: bigint | number): number => Number(lamports) / LAMPORTS_PER_SOL;

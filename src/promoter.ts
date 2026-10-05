import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { log } from "./logger.js";
import { sniffMediaType } from "./lib/imageGen.js";
import { oauth1Header, type OAuth1Credentials } from "./lib/oauth1.js";
import { httpJson } from "./lib/retry.js";

export interface PromoPost {
  name: string;
  ticker: string;
  description: string;
  hook?: string;
  mint: string;
  logoFile: string;
}

export interface PostResult {
  channel: "telegram" | "x";
  ok: boolean;
  url?: string;
  error?: string;
}

export type PromoConfig = Pick<
  Config,
  | "TELEGRAM_BOT_TOKEN"
  | "TELEGRAM_CHANNEL_ID"
  | "X_API_KEY"
  | "X_API_SECRET"
  | "X_ACCESS_TOKEN"
  | "X_ACCESS_SECRET"
  | "POST_DISCLAIMER"
>;

export const pumpLink = (mint: string) => `https://pump.fun/coin/${mint}`;

/** X counts every link as 23 characters. */
const X_LINK_LEN = 23;
const X_MAX = 280;

/**
 * Honest launch announcement: what the coin is, where to find it, the contract address and
 * a disclaimer. No price promises - those get accounts banned and mislead people.
 */
export function buildPostText(p: PromoPost, disclaimer: string, channel: "telegram" | "x"): string {
  const head = `${p.name} ($${p.ticker})`;
  const tail = [`CA: ${p.mint}`, disclaimer].filter(Boolean).join("\n");
  let body = (p.hook?.trim() || p.description.trim()).replace(/\s+/g, " ");

  if (channel === "telegram") {
    const text = [`🆕 ${head}`, body, p.hook ? p.description : "", pumpLink(p.mint), tail].filter(Boolean).join("\n\n");
    return text.slice(0, 1024); // Telegram photo caption limit
  }
  // Budget for X: head + body + link + tail + 4 newline pairs.
  const fixed = head.length + X_LINK_LEN + tail.length + 8;
  const room = X_MAX - fixed;
  if (body.length > room) body = room > 1 ? `${body.slice(0, room - 1).trimEnd()}…` : "";
  return [head, body, pumpLink(p.mint), tail].filter(Boolean).join("\n\n");
}

export async function postTelegram(cfg: PromoConfig, p: PromoPost, fetchImpl: typeof fetch = fetch): Promise<PostResult> {
  if (!cfg.TELEGRAM_BOT_TOKEN || !cfg.TELEGRAM_CHANNEL_ID) return { channel: "telegram", ok: false, error: "not configured" };
  const bytes = fs.readFileSync(p.logoFile);
  const form = new FormData();
  form.append("chat_id", cfg.TELEGRAM_CHANNEL_ID);
  form.append("caption", buildPostText(p, cfg.POST_DISCLAIMER, "telegram"));
  form.append("photo", new Blob([bytes], { type: sniffMediaType(bytes) }), path.basename(p.logoFile));
  const res = await httpJson<{ ok: boolean; result?: { message_id: number; chat?: { username?: string } }; description?: string }>(
    `https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/sendPhoto`,
    { method: "POST", body: form },
    { fetchImpl, retries: 2, label: "telegram" },
  );
  if (!res.ok || !res.result) return { channel: "telegram", ok: false, error: res.description ?? "telegram error" };
  const username = res.result.chat?.username ?? cfg.TELEGRAM_CHANNEL_ID.replace(/^@/, "");
  return { channel: "telegram", ok: true, url: `https://t.me/${username}/${res.result.message_id}` };
}

function xCreds(cfg: PromoConfig): OAuth1Credentials | undefined {
  if (!cfg.X_API_KEY || !cfg.X_API_SECRET || !cfg.X_ACCESS_TOKEN || !cfg.X_ACCESS_SECRET) return undefined;
  return { consumerKey: cfg.X_API_KEY, consumerSecret: cfg.X_API_SECRET, token: cfg.X_ACCESS_TOKEN, tokenSecret: cfg.X_ACCESS_SECRET };
}

/** Self-healing: if the image upload fails the post still goes out as text only. */
export async function postX(cfg: PromoConfig, p: PromoPost, fetchImpl: typeof fetch = fetch): Promise<PostResult> {
  const creds = xCreds(cfg);
  if (!creds) return { channel: "x", ok: false, error: "not configured" };

  let mediaId: string | undefined;
  try {
    const uploadUrl = "https://api.x.com/2/media/upload";
    const bytes = fs.readFileSync(p.logoFile);
    const form = new FormData();
    form.append("media", new Blob([bytes], { type: sniffMediaType(bytes) }), path.basename(p.logoFile));
    form.append("media_category", "tweet_image");
    const up = await httpJson<{ data?: { id?: string } }>(
      uploadUrl,
      { method: "POST", headers: { Authorization: oauth1Header("POST", uploadUrl, creds) }, body: form },
      { fetchImpl, retries: 1, label: "x media" },
    );
    mediaId = up.data?.id;
  } catch (err) {
    log.warn("x image upload failed, posting text only", { error: String(err) });
  }

  const tweetUrl = "https://api.x.com/2/tweets";
  const res = await httpJson<{ data?: { id?: string } }>(
    tweetUrl,
    {
      method: "POST",
      headers: { Authorization: oauth1Header("POST", tweetUrl, creds), "Content-Type": "application/json" },
      body: JSON.stringify({
        text: buildPostText(p, cfg.POST_DISCLAIMER, "x"),
        ...(mediaId ? { media: { media_ids: [mediaId] } } : {}),
      }),
    },
    { fetchImpl, retries: 1, label: "x post" },
  );
  const id = res.data?.id;
  return id ? { channel: "x", ok: true, url: `https://x.com/i/status/${id}` } : { channel: "x", ok: false, error: "no tweet id" };
}

export function promotionChannels(cfg: PromoConfig): ("telegram" | "x")[] {
  const out: ("telegram" | "x")[] = [];
  if (cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_CHANNEL_ID) out.push("telegram");
  if (xCreds(cfg)) out.push("x");
  return out;
}

/** Posts to every configured channel. Never throws: a failed post must not fail a launch. */
export async function promoteLaunch(cfg: PromoConfig, p: PromoPost, fetchImpl: typeof fetch = fetch): Promise<PostResult[]> {
  const jobs = promotionChannels(cfg).map(async (ch): Promise<PostResult> => {
    try {
      return ch === "telegram" ? await postTelegram(cfg, p, fetchImpl) : await postX(cfg, p, fetchImpl);
    } catch (err) {
      return { channel: ch, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  const results = await Promise.all(jobs);
  for (const r of results) {
    if (r.ok) log.info("posted launch", { channel: r.channel, url: r.url });
    else log.warn("post failed", { channel: r.channel, error: r.error });
  }
  return results;
}

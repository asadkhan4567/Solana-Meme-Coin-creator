import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Config } from "../config.js";

export interface ImageInput {
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  base64: string;
}

/** Minimal interface the creative director needs; lets tests plug in fakes. */
export interface LlmClient {
  readonly name: string;
  /** Returns the parsed JSON object the model produced. */
  json(system: string, user: string, images?: ImageInput[]): Promise<unknown>;
}

/** Pulls the first JSON object out of a model reply (tolerates ```json fences and chatter). */
export function parseJsonReply(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`model reply had no JSON object: ${text.slice(0, 200)}`);
  return JSON.parse(body.slice(start, end + 1));
}

export class ClaudeClient implements LlmClient {
  readonly name = "claude";
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 3 });
  }

  async json(system: string, user: string, images: ImageInput[] = []): Promise<unknown> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      ...images.map(
        (img): Anthropic.Beta.BetaContentBlockParam => ({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.base64 },
        }),
      ),
      { type: "text", text: user },
    ];
    const res = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 4000,
      // Short creative/judging task: low effort keeps it fast and cheap.
      output_config: { effort: "low" },
      // If a safety classifier declines, the API retries on a fallback model in the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      messages: [{ role: "user", content }],
    });
    if (res.stop_reason === "refusal") throw new Error("claude declined the request");
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    return parseJsonReply(text);
  }
}

export class GptClient implements LlmClient {
  readonly name = "gpt";
  private readonly client: OpenAI;

  constructor(apiKey: string, private readonly model: string) {
    this.client = new OpenAI({ apiKey, maxRetries: 3 });
  }

  async json(system: string, user: string, images: ImageInput[] = []): Promise<unknown> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            ...images.map((img) => ({
              type: "image_url" as const,
              image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
            })),
            { type: "text" as const, text: user },
          ],
        },
      ],
    });
    const text = res.choices[0]?.message?.content;
    if (!text) throw new Error("gpt returned an empty reply");
    return parseJsonReply(text);
  }
}

export function buildLlms(cfg: Config): LlmClient[] {
  const out: LlmClient[] = [];
  if (cfg.ANTHROPIC_API_KEY) out.push(new ClaudeClient(cfg.ANTHROPIC_API_KEY, cfg.ANTHROPIC_MODEL));
  if (cfg.OPENAI_API_KEY) out.push(new GptClient(cfg.OPENAI_API_KEY, cfg.OPENAI_MODEL));
  return out;
}

import OpenAI from "openai";
import type { Config } from "../config.js";
import { httpBytes, httpJson } from "./retry.js";

export interface ImageProvider {
  readonly name: string;
  /** Returns PNG/JPEG bytes. */
  generate(prompt: string): Promise<Buffer>;
}

const LOGO_STYLE =
  "Square meme-coin logo, single bold mascot centered, thick clean outlines, vivid flat colors, " +
  "simple solid background, high contrast, reads well at 64x64, no text, no letters, no watermark.";

export const logoPrompt = (idea: string) => `${idea.trim()}. ${LOGO_STYLE}`;

export class DalleProvider implements ImageProvider {
  readonly name = "dalle";
  private readonly client: OpenAI;

  constructor(apiKey: string, private readonly model: string) {
    this.client = new OpenAI({ apiKey, maxRetries: 3 });
  }

  async generate(prompt: string): Promise<Buffer> {
    const isDalle = this.model.startsWith("dall-e");
    const res = await this.client.images.generate({
      model: this.model,
      prompt: logoPrompt(prompt),
      size: "1024x1024",
      n: 1,
      // dall-e-* can return base64; gpt-image-* always does and rejects this field.
      ...(isDalle ? { response_format: "b64_json" as const } : {}),
    });
    const img = res.data?.[0];
    if (img?.b64_json) return Buffer.from(img.b64_json, "base64");
    if (img?.url) return httpBytes(img.url);
    throw new Error("image API returned no image");
  }
}

/** Flux via fal.ai's synchronous endpoint (https://fal.run/<model>). */
export class FluxProvider implements ImageProvider {
  readonly name = "flux";

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async generate(prompt: string): Promise<Buffer> {
    const res = await httpJson<{ images?: { url: string }[] }>(
      `https://fal.run/${this.model}`,
      {
        method: "POST",
        headers: { Authorization: `Key ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: logoPrompt(prompt), image_size: "square_hd", num_images: 1 }),
      },
      { fetchImpl: this.fetchImpl, timeoutMs: 120_000, retries: 2, label: "flux" },
    );
    const url = res.images?.[0]?.url;
    if (!url) throw new Error("flux returned no image");
    return httpBytes(url, { fetchImpl: this.fetchImpl });
  }
}

/** Pollinations.ai: free Flux image generation, no key required (token optional for higher limits). */
export class PollinationsProvider implements ImageProvider {
  constructor(
    readonly name: string,
    private readonly model: string,
    private readonly token?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async generate(prompt: string): Promise<Buffer> {
    const seed = Math.floor(Math.random() * 1_000_000_000);
    const qs = new URLSearchParams({
      width: "1024",
      height: "1024",
      model: this.model,
      nologo: "true",
      seed: String(seed),
    });
    if (this.token) qs.set("token", this.token);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(logoPrompt(prompt))}?${qs}`;
    const buf = await httpBytes(url, { fetchImpl: this.fetchImpl });
    if (buf.length < 1000) throw new Error(`${this.name} returned an invalid image`);
    return buf;
  }
}

/** Hugging Face Inference Providers, OpenAI-compatible images endpoint (e.g. FLUX.1-schnell on nscale). */
export class HuggingFaceProvider implements ImageProvider {
  readonly name: string;

  constructor(
    private readonly token: string,
    private readonly model: string,
    private readonly provider: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.name = `hf-${model.split("/").pop()!.toLowerCase()}`;
  }

  async generate(prompt: string): Promise<Buffer> {
    const res = await httpJson<{ data?: { b64_json?: string; url?: string }[] }>(
      `https://router.huggingface.co/${this.provider}/v1/images/generations`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: logoPrompt(prompt), response_format: "b64_json" }),
      },
      { fetchImpl: this.fetchImpl, timeoutMs: 120_000, retries: 2, label: this.name },
    );
    const img = res.data?.[0];
    if (img?.b64_json) return Buffer.from(img.b64_json, "base64");
    if (img?.url) return httpBytes(img.url, { fetchImpl: this.fetchImpl });
    throw new Error(`${this.name} returned no image`);
  }
}

export function buildImageProviders(cfg: Config): ImageProvider[] {
  const out: ImageProvider[] = [];
  if (cfg.HF_TOKEN) out.push(new HuggingFaceProvider(cfg.HF_TOKEN, cfg.HF_IMAGE_MODEL, cfg.HF_IMAGE_PROVIDER));
  if (cfg.POLLINATIONS_ENABLED) {
    // Two free contestants so the AI judge still has a choice.
    out.push(new PollinationsProvider("flux-free", "flux", cfg.POLLINATIONS_TOKEN));
    out.push(new PollinationsProvider("flux-free-2", "flux", cfg.POLLINATIONS_TOKEN));
  }
  if (cfg.OPENAI_API_KEY) out.push(new DalleProvider(cfg.OPENAI_API_KEY, cfg.OPENAI_IMAGE_MODEL));
  if (cfg.FAL_KEY) out.push(new FluxProvider(cfg.FAL_KEY, cfg.FLUX_MODEL));
  return out;
}

export function sniffMediaType(buf: Buffer): "image/png" | "image/jpeg" | "image/webp" {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "image/png";
}

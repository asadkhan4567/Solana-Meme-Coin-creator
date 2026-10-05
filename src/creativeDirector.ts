import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { checkNameAllowed } from "./guards.js";
import { log } from "./logger.js";
import { sniffMediaType, type ImageProvider } from "./lib/imageGen.js";
import type { LlmClient } from "./lib/llm.js";
import type { Trend } from "./trendScanner.js";

export const conceptSchema = z.object({
  name: z.string().trim().min(2).max(32),
  ticker: z
    .string()
    .trim()
    .transform((t) => t.replace(/^\$/, "").toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{2,10}$/)),
  description: z.string().trim().min(10).max(400),
  imagePrompt: z.string().trim().min(10).max(1000),
  twitterHook: z.string().trim().max(280).optional(),
});
export type Concept = z.infer<typeof conceptSchema>;

export interface ConceptCandidate {
  author: string; // which LLM wrote it
  concept: Concept;
  score: number; // summed judge scores
}

export interface LogoCandidate {
  provider: string;
  file: string;
  score: number;
}

export interface CreativeResult {
  concept: Concept;
  llmWinner: string;
  concepts: ConceptCandidate[];
  logoFile: string;
  imageWinner: string;
  logos: LogoCandidate[];
}

const CONCEPT_SYSTEM = `You are the creative director of a meme coin studio on pump.fun.
You turn a live internet trend into an ORIGINAL, funny, memorable coin.
Hard rules:
- Never use or imitate real people, celebrities, politicians, companies, brands, franchises or existing famous coin tickers.
- No promises of profit, no "official", no airdrop/giveaway language, no financial claims.
- Ticker: 3-8 uppercase letters, punchy and easy to type.
- Name: max 32 characters.
- Description: 1-2 sentences, playful, max 280 characters.
- imagePrompt: describe ONE original cartoon mascot for the logo (no text in the image).
Reply with ONLY a JSON object: {"name","ticker","description","imagePrompt","twitterHook"}.`;

const JUDGE_SYSTEM = `You are a ruthless meme coin judge. Score each option 1-10 on: virality, humor,
memorability of the ticker, fit with the trend, and originality. Penalize anything that imitates a
real person, brand or existing coin. Reply with ONLY JSON: {"scores":[number,...]} in the same order.`;

const LOGO_JUDGE_SYSTEM = `You judge meme coin logos. Score each image 1-10 for: instantly readable at
small size, funny/charming mascot, bold colors, no garbled text, fits the coin. Reply with ONLY JSON:
{"scores":[number,...]} in the same order as the images.`;

function trendBrief(trend: Trend): string {
  return [
    `Trend keyword: "${trend.theme}"`,
    `Related words: ${trend.related.join(", ") || "none"}`,
    `Evidence: ${trend.evidence.join(" | ")}`,
    `Signal sources: ${trend.sources.join(", ")}`,
  ].join("\n");
}

async function settle<T>(items: { name: string; run: () => Promise<T> }[]): Promise<{ name: string; value: T }[]> {
  const res = await Promise.allSettled(items.map((i) => i.run()));
  const ok: { name: string; value: T }[] = [];
  res.forEach((r, idx) => {
    const name = items[idx]!.name;
    if (r.status === "fulfilled") ok.push({ name, value: r.value });
    else log.warn("provider failed", { provider: name, error: String(r.reason) });
  });
  return ok;
}

/** Every available judge scores every option; scores are summed (reduces each model's self-bias). */
export async function panelScores(
  judges: LlmClient[],
  system: string,
  prompt: string,
  count: number,
  images?: Parameters<LlmClient["json"]>[2],
): Promise<number[]> {
  const scoreSchema = z.object({ scores: z.array(z.coerce.number().min(0).max(10)).length(count) });
  const votes = await settle(
    judges.map((j) => ({ name: j.name, run: async () => scoreSchema.parse(await j.json(system, prompt, images)).scores })),
  );
  const totals = new Array<number>(count).fill(0);
  for (const v of votes) v.value.forEach((s, i) => (totals[i]! += s));
  return totals;
}

export async function generateConcepts(trend: Trend, llms: LlmClient[], blocked: string[]): Promise<ConceptCandidate[]> {
  const user = `${trendBrief(trend)}\n\nCreate the coin.`;
  const raw = await settle(
    llms.map((l) => ({
      name: l.name,
      run: async () => {
        // One self-healing retry if the model returns invalid / disallowed output.
        for (let attempt = 0; attempt < 2; attempt++) {
          const parsed = conceptSchema.safeParse(await l.json(CONCEPT_SYSTEM, user));
          if (parsed.success) {
            const allowed = checkNameAllowed(parsed.data.name, parsed.data.ticker, blocked);
            if (allowed.ok) return parsed.data;
            log.warn("concept rejected by name filter", { provider: l.name, reason: allowed.reason });
          }
        }
        throw new Error("no valid concept after 2 attempts");
      },
    })),
  );
  return raw.map((r) => ({ author: r.name, concept: r.value, score: 0 }));
}

export async function judgeConcepts(trend: Trend, candidates: ConceptCandidate[], judges: LlmClient[]): Promise<ConceptCandidate[]> {
  if (candidates.length <= 1) return candidates;
  const list = candidates
    .map((c, i) => `${i + 1}. ${c.concept.name} ($${c.concept.ticker}) - ${c.concept.description}`)
    .join("\n");
  const scores = await panelScores(judges, JUDGE_SYSTEM, `${trendBrief(trend)}\n\nOptions:\n${list}`, candidates.length);
  return candidates.map((c, i) => ({ ...c, score: scores[i] ?? 0 })).sort((a, b) => b.score - a.score);
}

export async function generateLogos(concept: Concept, providers: ImageProvider[], outDir: string): Promise<LogoCandidate[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const prompt = `${concept.imagePrompt} (mascot for the meme coin "${concept.name}")`;
  const imgs = await settle(providers.map((p) => ({ name: p.name, run: () => p.generate(prompt) })));
  return imgs.map(({ name, value }) => {
    const ext = sniffMediaType(value) === "image/jpeg" ? "jpg" : sniffMediaType(value) === "image/webp" ? "webp" : "png";
    const file = path.join(outDir, `logo-${name}.${ext}`);
    fs.writeFileSync(file, value);
    return { provider: name, file, score: 0 };
  });
}

export async function judgeLogos(concept: Concept, logos: LogoCandidate[], judges: LlmClient[]): Promise<LogoCandidate[]> {
  if (logos.length <= 1) return logos;
  const images = logos.map((l) => {
    const buf = fs.readFileSync(l.file);
    return { mediaType: sniffMediaType(buf), base64: buf.toString("base64") };
  });
  const scores = await panelScores(
    judges,
    LOGO_JUDGE_SYSTEM,
    `Coin: ${concept.name} ($${concept.ticker}) - ${concept.description}\nScore the ${logos.length} images in order.`,
    logos.length,
    images,
  );
  return logos.map((l, i) => ({ ...l, score: scores[i] ?? 0 })).sort((a, b) => b.score - a.score);
}

/** Claude vs GPT for the concept, DALL-E vs Flux for the logo; a judge panel picks both winners. */
export async function runCreativeDirector(
  trend: Trend,
  llms: LlmClient[],
  images: ImageProvider[],
  outDir: string,
  blocked: string[] = [],
): Promise<CreativeResult> {
  if (llms.length === 0) throw new Error("no LLM provider configured");
  if (images.length === 0) throw new Error("no image provider configured");

  const concepts = await judgeConcepts(trend, await generateConcepts(trend, llms, blocked), llms);
  const best = concepts[0];
  if (!best) throw new Error("every LLM failed to produce a usable concept");

  const logos = await judgeLogos(best.concept, await generateLogos(best.concept, images, outDir), llms);
  const logo = logos[0];
  if (!logo) throw new Error("every image provider failed");

  log.info("creative winner", {
    name: best.concept.name,
    ticker: best.concept.ticker,
    llmWinner: best.author,
    conceptScores: concepts.map((c) => `${c.author}:${c.score}`),
    imageWinner: logo.provider,
    logoScores: logos.map((l) => `${l.provider}:${l.score}`),
  });
  return { concept: best.concept, llmWinner: best.author, concepts, logoFile: logo.file, imageWinner: logo.provider, logos };
}

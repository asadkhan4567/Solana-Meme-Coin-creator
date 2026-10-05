import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { Concept } from "./creativeDirector.js";
import { httpJson } from "./lib/retry.js";
import { sniffMediaType } from "./lib/imageGen.js";

/** Shape pump.fun expects at the metadata URI (see pump-fun-skills create-coin/references/METADATA.md). */
export interface CoinMetadata {
  name: string;
  symbol: string;
  description: string;
  image: string;
  showName: boolean;
  createdOn: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export interface UploadResult {
  imageUri: string;
  metadataUri: string;
  metadata: CoinMetadata;
}

export function buildMetadata(concept: Concept, imageUri: string, links: Partial<Pick<CoinMetadata, "twitter" | "telegram" | "website">> = {}): CoinMetadata {
  return {
    name: concept.name,
    symbol: concept.ticker,
    description: concept.description,
    image: imageUri,
    showName: true,
    createdOn: "https://pump.fun",
    ...Object.fromEntries(Object.entries(links).filter(([, v]) => v)),
  };
}

/** Pins the logo, then the metadata JSON, to IPFS through Pinata. Returns the metadata URI. */
export async function uploadMetadata(
  cfg: Pick<Config, "PINATA_JWT" | "IPFS_GATEWAY">,
  concept: Concept,
  logoFile: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadResult> {
  if (!cfg.PINATA_JWT) throw new Error("PINATA_JWT is not set");
  const auth = { Authorization: `Bearer ${cfg.PINATA_JWT}` };
  const gateway = cfg.IPFS_GATEWAY.endsWith("/") ? cfg.IPFS_GATEWAY : `${cfg.IPFS_GATEWAY}/`;

  const bytes = fs.readFileSync(logoFile);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: sniffMediaType(bytes) }), path.basename(logoFile));
  form.append("pinataMetadata", JSON.stringify({ name: `${concept.ticker}-logo` }));
  const img = await httpJson<{ IpfsHash: string }>(
    "https://api.pinata.cloud/pinning/pinFileToIPFS",
    { method: "POST", headers: auth, body: form },
    { fetchImpl, label: "pinata", timeoutMs: 120_000 },
  );
  const imageUri = `${gateway}${img.IpfsHash}`;

  const metadata = buildMetadata(concept, imageUri);
  const meta = await httpJson<{ IpfsHash: string }>(
    "https://api.pinata.cloud/pinning/pinJSONToIPFS",
    {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ pinataContent: metadata, pinataMetadata: { name: `${concept.ticker}-metadata` } }),
    },
    { fetchImpl, label: "pinata" },
  );
  return { imageUri, metadataUri: `${gateway}${meta.IpfsHash}`, metadata };
}

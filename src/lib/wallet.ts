import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

/**
 * Accepts either a base58 secret key (what Phantom's "Export Private Key" gives you)
 * or a JSON byte array like `[12,34,...]` (solana-keygen format).
 * Never logs or returns the secret.
 */
export function parseSecretKey(raw: string): Uint8Array {
  const value = raw.trim();
  let bytes: Uint8Array;
  if (value.startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(value);
    } catch {
      throw new Error("SIGNER_PRIVATE_KEY looks like a JSON array but is not valid JSON");
    }
    if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error("SIGNER_PRIVATE_KEY JSON array must contain only bytes (0-255)");
    }
    bytes = Uint8Array.from(arr as number[]);
  } else {
    try {
      bytes = bs58.decode(value);
    } catch {
      throw new Error("SIGNER_PRIVATE_KEY is neither base58 nor a JSON byte array");
    }
  }
  if (bytes.length !== 64) {
    throw new Error(`SIGNER_PRIVATE_KEY must decode to 64 bytes (got ${bytes.length})`);
  }
  return bytes;
}

export function loadKeypair(raw: string | undefined): Keypair | undefined {
  if (!raw) return undefined;
  return Keypair.fromSecretKey(parseSecretKey(raw));
}

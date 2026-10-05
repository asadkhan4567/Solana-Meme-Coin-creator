/** Ported from pump-fun-skills create-coin/scripts/lib/jito.mjs (send-only part). */
export const JITO_ENDPOINTS = [
  "https://mainnet.block-engine.jito.wtf/api/v1/transactions",
  "https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/transactions",
  "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/transactions",
  "https://london.mainnet.block-engine.jito.wtf/api/v1/transactions",
  "https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions",
  "https://slc.mainnet.block-engine.jito.wtf/api/v1/transactions",
  "https://singapore.mainnet.block-engine.jito.wtf/api/v1/transactions",
  "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/transactions",
];

/**
 * Sends a base64 transaction to every Jito block engine; resolves with the first success.
 * Front-run-protected transactions must ONLY go here, never to a public RPC.
 */
export async function sendTransactionToJito(txBase64: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "sendTransaction",
    params: [txBase64, { encoding: "base64" }],
  });
  const results = await Promise.allSettled(
    JITO_ENDPOINTS.map(async (url) => {
      const r = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await r.json()) as { result?: string; error?: unknown };
      if (json.error || !json.result) throw new Error(JSON.stringify(json.error ?? "no result"));
      return json.result;
    }),
  );
  const ok = results.find((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled");
  if (ok) return ok.value;
  const errors = results.map((r) => (r as PromiseRejectedResult).reason?.message ?? String(r));
  throw new Error(`All Jito endpoints failed: ${errors.join("; ")}`);
}

import { Connection } from "@solana/web3.js";
import { log } from "../logger.js";
import { isRetryable, withRetry } from "./retry.js";

/**
 * Self-healing RPC access: retries on the current endpoint, then rotates to the next
 * one in the list. The last healthy endpoint stays "current" for later calls.
 */
export class RpcPool {
  private readonly connections: Connection[];
  private current = 0;

  constructor(urls: string[], commitment: "confirmed" | "finalized" = "confirmed") {
    const unique = [...new Set(urls.filter(Boolean))];
    if (unique.length === 0) throw new Error("RpcPool needs at least one RPC URL");
    this.connections = unique.map((u) => new Connection(u, { commitment }));
  }

  get connection(): Connection {
    return this.connections[this.current]!;
  }

  get size(): number {
    return this.connections.length;
  }

  async call<T>(label: string, fn: (c: Connection) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < this.connections.length; i++) {
      const idx = (this.current + i) % this.connections.length;
      try {
        const result = await withRetry(() => fn(this.connections[idx]!), { retries: 2, baseMs: 400, label });
        if (idx !== this.current) {
          log.warn("rpc failover", { label, to: this.connections[idx]!.rpcEndpoint.replace(/\?.*$/, "") });
          this.current = idx;
        }
        return result;
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err)) throw err;
      }
    }
    throw lastErr;
  }
}

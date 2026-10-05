import fs from "node:fs";
import path from "node:path";

export interface Snapshot {
  at: string;
  usdMarketCap: number | null;
  complete: boolean;
  replyCount: number | null;
}

export type Outcome = "pending" | "success" | "dud";

export interface LaunchRecord {
  id: string;
  createdAt: string;
  dryRun: boolean;
  theme: string;
  trendScore: number;
  sources: string[];
  name: string;
  ticker: string;
  llmWinner: string;
  imageWinner: string;
  metadataUri: string;
  initialBuyLamports: string;
  mint?: string;
  signature?: string;
  snapshots: Snapshot[];
  outcome: Outcome;
  lastFeeCollectAt?: string;
  feesCollectedLamports: string;
}

export interface SourceStat {
  launches: number;
  successes: number;
}

export interface AgentState {
  version: 1;
  launches: LaunchRecord[];
  sourceStats: Record<string, SourceStat>;
  pausedUntil?: string;
  lastFeeRunAt?: string;
}

const empty = (): AgentState => ({ version: 1, launches: [], sourceStats: {} });

/** Small JSON-file store. Writes are atomic (tmp file + rename) so a crash never corrupts state. */
export class Store {
  private readonly file: string;
  state: AgentState;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "state.json");
    this.state = this.read();
  }

  private read(): AgentState {
    if (!fs.existsSync(this.file)) return empty();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as AgentState;
      return { ...empty(), ...parsed };
    } catch {
      // Self-heal: keep the broken file for inspection and start clean.
      fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      return empty();
    }
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  addLaunch(rec: LaunchRecord): void {
    this.state.launches.push(rec);
    this.save();
  }

  /** Real (non-dry-run) launches that have a mint on chain. */
  liveLaunches(): LaunchRecord[] {
    return this.state.launches.filter((l) => !l.dryRun && l.mint);
  }
}

/**
 * One structured line per request. Never includes payload contents or
 * response bodies; record keys are identifiers, not payload.
 */
export interface RequestLog {
  ts: string;
  request_id: string;
  method: string;
  endpoint: string;
  source: string | null;
  record_key: string | null;
  status: number;
  latency_ms: number;
  cache: 'hit' | 'miss' | 'bypass';
  /** API-key tier (Task 4). `anonymous` until auth lands. */
  tier: string;
  /** Support-visible API key prefix (Task 4); never the key itself. */
  key_prefix: string | null;
  problem: string | null;
}

export interface Logger {
  log(entry: RequestLog): void;
}

export class ConsoleLogger implements Logger {
  log(entry: RequestLog): void {
    console.log(JSON.stringify(entry));
  }
}

export class MemoryLogger implements Logger {
  readonly entries: RequestLog[] = [];
  log(entry: RequestLog): void {
    this.entries.push(entry);
  }
}

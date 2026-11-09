/**
 * In-memory token buckets keyed by client. Each key holds up to `capacity` tokens and regains
 * `refillPerSec` per second; a request spends one token or is refused with the exact time until it
 * would succeed. Pure and clock-injected, so tests can step time.
 *
 * Memory is bounded: at most `maxKeys` buckets; the least recently used bucket is evicted (Map
 * insertion order, refreshed on every use), in O(1). Eviction can only ever *forgive*
 * a client (it starts again with a full bucket), never punish one, so a flood of distinct keys
 * cannot lock anyone out; it can only weaken protection for the evicted keys, which is why
 * `maxKeys` is far above the number of clients a single server sees at once.
 */
export interface BucketConfig {
  capacity: number;
  refillPerSec: number;
  maxKeys: number;
}

export interface TakeResult {
  ok: boolean;
  /** Whole tokens left after this request. */
  remaining: number;
  /** Seconds until one token is available (0 when ok). Always ≥ 1 when refused. */
  retryAfterSec: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    readonly config: BucketConfig,
    private readonly now: () => number = Date.now,
  ) {
    if (!(config.capacity >= 1) || !(config.refillPerSec > 0) || !(config.maxKeys >= 1))
      throw new Error("invalid token bucket configuration");
  }

  get size() {
    return this.buckets.size;
  }

  /** Tokens `key` would have now, without spending any (a missing key has a full bucket). */
  available(key: string): number {
    const prev = this.buckets.get(key);
    if (!prev) return this.config.capacity;
    const elapsed = Math.max(0, this.now() - prev.at) / 1000;
    return Math.min(this.config.capacity, prev.tokens + elapsed * this.config.refillPerSec);
  }

  take(key: string): TakeResult {
    const t = this.now();
    const { capacity, refillPerSec } = this.config;
    const prev = this.buckets.get(key);
    // A clock that steps backwards (NTP) never adds or removes tokens.
    const elapsed = prev ? Math.max(0, t - prev.at) / 1000 : 0;
    const tokens = prev ? Math.min(capacity, prev.tokens + elapsed * refillPerSec) : capacity;
    if (prev) this.buckets.delete(key); // re-inserted below: most recently used goes last
    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, at: t });
      this.evict();
      return { ok: true, remaining: Math.floor(tokens - 1), retryAfterSec: 0 };
    }
    this.buckets.set(key, { tokens, at: t });
    this.evict();
    return { ok: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((1 - tokens) / refillPerSec)) };
  }

  /** O(1) per request: drop least recently used buckets (never a full scan, which a flood of
   *  distinct keys could otherwise turn into a CPU cost on every request). */
  private evict() {
    while (this.buckets.size > this.config.maxKeys) {
      const oldest = this.buckets.keys().next().value as string;
      this.buckets.delete(oldest);
    }
  }
}

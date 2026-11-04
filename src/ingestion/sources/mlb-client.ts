import { mkdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fetchJson } from "../http";
import { fingerprint } from "../plan";
import { mlbBaseUrl } from "./mlb-config";
import { progress } from "../progress";
export interface SourceDocument {
  url: string;
  fetchedAt: string;
  /** sha256 of the stable-JSON response body, computed when fetched. */
  contentHash: string;
  /** Present unless the client was created with retainBodies: false. */
  body?: unknown;
}
export interface MlbClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  recordDir?: string;
  /** Requests allowed in flight at once (default 1; bounded 1–8). */
  concurrency?: number;
  /** Minimum spacing between request starts in ms (default 100). */
  minIntervalMs?: number;
  /**
   * Keep full response bodies on `documents` (default true). Large captures set false so only
   * the url/time/hash manifest is retained; callers keep whatever projection they need.
   */
  retainBodies?: boolean;
}
/**
 * Bounded-concurrency JSON client: at most `concurrency` requests in flight, starts spaced by
 * `minIntervalMs`, URL caching for the capture, and bounded transport retries (fetchJson).
 * Defaults (1 in flight, 100 ms) preserve the original AFL behavior.
 */
export class MlbClient {
  private cache = new Map<string, Promise<unknown>>();
  readonly documents: SourceDocument[] = [];
  private readonly base: URL;
  private active = 0;
  private waiting: (() => void)[] = [];
  private nextStart: Promise<void> = Promise.resolve();
  private readonly concurrency: number;
  constructor(options: MlbClientOptions = {}) {
    this.options = options;
    this.concurrency = Math.min(8, Math.max(1, Math.floor(options.concurrency ?? 1)));
    this.base = mlbBaseUrl(options.baseUrl);
    if (options.recordDir) {
      const path = resolve(options.recordDir);
      for (const folder of ["public", "src", ".git"]) {
        const rel = relative(resolve(folder), path);
        if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/")))
          throw new Error("Record raw responses outside public/src/.git");
      }
    }
  }
  private readonly options;
  private sleep(ms: number) {
    return (this.options.sleep ?? ((t) => new Promise((r) => setTimeout(r, t))))(ms);
  }
  /** Waits for a concurrency slot, then for the start-spacing interval. */
  private async acquire() {
    if (this.active >= this.concurrency)
      await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    const turn = this.nextStart;
    let release!: () => void;
    this.nextStart = new Promise<void>((r) => (release = r));
    await turn;
    await this.sleep(this.options.minIntervalMs ?? 100);
    release();
  }
  private releaseSlot() {
    this.active--;
    this.waiting.shift()?.();
  }
  get(
    path: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<unknown> {
    if (path.startsWith("/") || path.includes(":") || path.includes(".."))
      throw new Error("Expected a relative MLB API endpoint");
    const url = new URL(path, this.base);
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const key = url.href;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const request = (async () => {
      await this.acquire();
      const startedAt = Date.now();
      try {
        const body = await fetchJson(url, {
          fetcher: this.options.fetcher,
          sleep: this.options.sleep,
          maxBytes: 10_000_000,
          timeoutMs: 15000,
        });
        const document: SourceDocument = {
          url: key,
          fetchedAt: new Date().toISOString(),
          contentHash: fingerprint(body),
          ...(this.options.retainBodies === false ? {} : { body }),
        };
        this.documents.push(document);
        progress("http:get", {
          path: url.pathname,
          ms: Date.now() - startedAt,
          n: this.documents.length,
        });
        if (this.options.recordDir) {
          await mkdir(this.options.recordDir, { recursive: true });
          await writeFile(
            resolve(
              this.options.recordDir,
              `${fingerprint(key)}-${document.contentHash}.json`,
            ),
            JSON.stringify({ ...document, body }, null, 2),
            { flag: "wx" },
          ).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          });
        }
        return body;
      } catch (error) {
        progress("http:failed", {
          path: url.pathname,
          ms: Date.now() - startedAt,
        });
        throw new Error(
          `${url.pathname}: ${error instanceof Error ? error.message : "request failed"}`,
        );
      } finally {
        this.releaseSlot();
      }
    })();
    this.cache.set(key, request);
    return request;
  }
}

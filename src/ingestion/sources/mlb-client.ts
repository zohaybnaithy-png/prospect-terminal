import { mkdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fetchJson } from "../http";
import { fingerprint } from "../plan";
import { mlbBaseUrl } from "./mlb-config";
import { progress } from "../progress";
export interface SourceDocument {
  url: string;
  fetchedAt: string;
  body: unknown;
}
/** One in-flight request, 100ms between starts, URL caching, bounded transport retries. */
export class MlbClient {
  private queue: Promise<unknown> = Promise.resolve();
  private cache = new Map<string, Promise<unknown>>();
  readonly documents: SourceDocument[] = [];
  private readonly base: URL;
  constructor(
    options: {
      baseUrl?: string;
      fetcher?: typeof fetch;
      sleep?: (ms: number) => Promise<void>;
      recordDir?: string;
    } = {},
  ) {
    this.options = options;
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
    const request = this.queue.then(async () => {
      await (
        this.options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
      )(100);
      const startedAt = Date.now();
      try {
        const body = await fetchJson(url, {
          fetcher: this.options.fetcher,
          sleep: this.options.sleep,
          maxBytes: 10_000_000,
          timeoutMs: 15000,
        });
        const document = {
          url: key,
          fetchedAt: new Date().toISOString(),
          body,
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
              `${fingerprint(key)}-${fingerprint(body)}.json`,
            ),
            JSON.stringify(document, null, 2),
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
      }
    });
    this.cache.set(key, request);
    this.queue = request.catch(() => undefined);
    return request;
  }
}

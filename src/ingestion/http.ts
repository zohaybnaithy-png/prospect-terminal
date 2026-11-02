import { progress } from "./progress";
/** Bounded JSON transport. Inject fetch/sleep in tests; no scraping, redirects, or TLS overrides. */
export async function fetchJson(
  url: URL,
  {
    fetcher = fetch,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    attempts = 3,
    maxBytes = 2_000_000,
    timeoutMs = 8000,
  }: {
    fetcher?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    attempts?: number;
    maxBytes?: number;
    timeoutMs?: number;
  } = {},
): Promise<unknown> {
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("HTTPS without embedded credentials is required");
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Response;
    try {
      response = await fetcher(url, {
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt + 1 < attempts) {
        progress("http:retry", {
          path: url.pathname,
          attempt: attempt + 1,
          reason: error instanceof Error ? error.name : "transport",
        });
        await sleep(Math.min(250 * 2 ** attempt, 2000));
        continue;
      }
      throw new Error(
        `Source transport failed after ${attempts} attempts: ${error instanceof Error ? error.message : "request failed"}`,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (
        (response.status === 429 || response.status >= 500) &&
        attempt + 1 < attempts
      ) {
        progress("http:retry", {
          path: url.pathname,
          attempt: attempt + 1,
          reason: `HTTP ${response.status}`,
        });
        const seconds = Number(response.headers.get("retry-after"));
        await sleep(
          Number.isFinite(seconds) && seconds > 0
            ? Math.min(seconds * 1000, 2000)
            : Math.min(250 * 2 ** attempt, 2000),
        );
        continue;
      }
      throw new Error(`Source HTTP ${response.status}`);
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel();
      throw new Error("Source response is not JSON");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Source returned an empty body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error("Source response exceeds size limit");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }
  throw new Error("Source retry budget exhausted");
}

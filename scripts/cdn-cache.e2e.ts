/**
 * CDN caching and snapshot serving against a REAL production build (docs/VERCEL.md).
 *
 *   npm run test:cdn:e2e        # ~1–2 min: writes a fictional snapshot, runs `next build`, `next start`
 *
 * What it proves locally, end to end through Next.js's real routing, header and Proxy layers:
 * - a snapshot build serves pages with NO database (DATABASE_URL points at a closed port);
 * - exactly which responses carry `Vercel-CDN-Cache-Control` (status codes, query strings, RSC
 *   router requests, `_rsc` URLs, health and development pages, redirects);
 * - `no-store` set by the proxy (429) and by a route handler (data-state 404) wins over the
 *   next.config rule;
 * - browsers never get a cacheable `Cache-Control` for pages.
 *
 * What it cannot prove (Vercel only; preview checks in docs/VERCEL.md): that Vercel's CDN acts on
 * the header, which statuses it stores, cache scoping, and how it orders Proxy and its cache. It
 * runs Next.js in normal mode, which validates `_rsc` (Vercel's minimal mode does not); the cache
 * rules are written not to depend on that validation.
 *
 * Leaves `.next/` holding this snapshot build: run `npm run build` afterwards for a normal build.
 * Uses only fictional fixture data; never touches a database.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { writeSnapshotDir } from "../src/services/competition/snapshot-store";
import { CDN_CACHE_VALUE } from "../src/lib/cdn-cache";
import { scaleSnapshot } from "./milb-scale-support";
import { trajectorySnapshot } from "./analytics-test-support";
import type { LevelId } from "../src/services/players/levels";
import type { AflSnapshot } from "../src/services/afl/types";

const ROOT = path.resolve(import.meta.dirname, "..");
const SNAP_DIR = ".data-snapshot-e2e";
const NEXT = path.join(ROOT, "node_modules", ".bin", "next");
const UNREACHABLE_DB = "postgresql://nobody:nothing@127.0.0.1:1/none";

let server: ChildProcess | undefined;
let base = "";
let output = "";

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

before(async () => {
  const levels = new Map<LevelId, AflSnapshot | null>([
    ["afl", trajectorySnapshot()],
    ["aaa", scaleSnapshot({ ns: 1, level: "aaa", teams: 6, days: 30, seed: 1 })],
    ["aa", scaleSnapshot({ ns: 2, level: "aa", teams: 6, days: 30, seed: 2 })],
    ["high-a", scaleSnapshot({ ns: 3, level: "high-a", teams: 6, days: 30, seed: 3 })],
    ["single-a", null], // not ingested: /trends/data answers its data-state 404
  ]);
  await writeSnapshotDir(path.join(ROOT, SNAP_DIR), { season: 2026, ingestionVersion: "e2e-fixture", levels });
  const env: NodeJS.ProcessEnv = { ...process.env, PT_DATA_SOURCE: "snapshot", PT_SNAPSHOT_DIR: SNAP_DIR, NEXT_TELEMETRY_DISABLED: "1" };
  delete env.DATABASE_URL;
  delete env.VERCEL;
  const build = spawnSync(NEXT, ["build"], { cwd: ROOT, env, encoding: "utf8" });
  assert.equal(build.status, 0, `next build failed:\n${build.stdout}\n${build.stderr}`);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(NEXT, ["start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: ROOT,
    env: {
      ...env,
      NODE_ENV: "production",
      DATABASE_URL: UNREACHABLE_DB, // must never be used in snapshot mode
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_BRANCH_URL: "pt-git-e2e.vercel.app",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.on("data", (d) => (output += d));
  server.stderr!.on("data", (d) => (output += d));
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.status === 200) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not become ready:\n${output}`);
});

after(() => {
  server?.kill("SIGTERM");
  rmSync(path.join(ROOT, SNAP_DIR), { recursive: true, force: true });
});

let ip = 10;
/** Each call comes from a fresh client address unless one is given (keeps rate limits out of the way). */
const get = (url: string, headers: Record<string, string> = {}, method = "GET") =>
  fetch(base + url, { method, redirect: "manual", headers: { "x-vercel-forwarded-for": `198.51.100.${ip++ % 250}`, ...headers } });
const cdn = (r: Response) => r.headers.get("vercel-cdn-cache-control");

test("serves real pages from the snapshot with an unreachable database", async () => {
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.status, "ready");
  assert.ok(Object.values(health.levels).every((s) => s === "ready"), JSON.stringify(health.levels));
  const html = await (await get("/players?level=aa")).text();
  assert.match(html, /Hitter 2-\d+-\d+/, "fixture players rendered");
  assert.doesNotMatch(output, /\[db\]|ECONNREFUSED|load failed/, "no database access was attempted");
});

test("public pages: 200 with the CDN header; browsers get no cacheable Cache-Control", async () => {
  const profile = /\/players\/[0-9a-f-]{36}/.exec(await (await get("/players?level=aa")).text())![0];
  for (const url of ["/", "/players", "/players?level=aa&sort=mom&dir=asc", "/players?utm_source=x", profile, `${profile}?level=aa`, "/trends", "/trends?level=aaa", "/data", "/robots.txt", "/sitemap.xml"]) {
    const r = await get(url);
    assert.equal(r.status, 200, url);
    assert.equal(cdn(r), CDN_CACHE_VALUE, url);
    const cc = r.headers.get("cache-control") ?? "";
    assert.doesNotMatch(cc, /s-maxage|public, max-age=[1-9]/, `${url}: ${cc}`);
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow", `${url}: preview is never indexed`);
  }
  const head = await get("/players", {}, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(cdn(head), CDN_CACHE_VALUE);
});

test("deterministic non-200 page answers: unknown player 404 is cached; redirects are not", async () => {
  for (const url of ["/players/00000000-0000-4000-8000-000000000000", "/players/not-a-uuid"]) {
    const r = await get(url);
    assert.equal(r.status, 404, url);
    assert.equal(cdn(r), CDN_CACHE_VALUE, `${url}: same answer for every visitor of this deployment`);
  }
  // Next.js answers the trailing-slash form before next.config headers apply.
  const slash = await get("/players/");
  assert.equal(slash.status, 308);
  assert.equal(cdn(slash), null);
});

test("/trends/data sets the CDN header itself, only on a successful answer", async () => {
  const ok = await get("/trends/data?view=map&level=aa&role=hitter&window=14d");
  assert.equal(ok.status, 200);
  assert.equal(cdn(ok), CDN_CACHE_VALUE);
  const bad = await get("/trends/data?view=nope");
  assert.equal(bad.status, 400);
  assert.equal(cdn(bad), null);
  const routerish = await get("/trends/data?view=map&level=aa&role=hitter&window=14d&_rsc=x");
  assert.equal(routerish.status, 200);
  assert.equal(cdn(routerish), "no-store", "the route adds nothing for a non-plain request; the proxy marks it");
});

test("data-state answers are never cached (no next.config rule can override the route's no-store)", async () => {
  const r = await get("/trends/data?view=map&level=single-a&role=hitter&window=14d");
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, "not-loaded");
  assert.equal(cdn(r), "no-store");
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("never cached: /health, development pages, retired routes", async () => {
  for (const [url, status] of [
    ["/health", 200],
    ["/analytics/models", 404],
    ["/market", 307],
    ["/screener", 307],
  ] as const) {
    const r = await get(url);
    assert.equal(r.status, status, url);
    assert.equal(cdn(r), null, url);
  }
});

test("RSC router requests and _rsc URLs are never cached", async () => {
  // A hand-made RSC request without `_rsc`: Next.js (normal mode) redirects to the hashed URL.
  const bare = await get("/players", { RSC: "1" });
  assert.equal(bare.status, 307);
  assert.equal(cdn(bare), "no-store");
  const hashed = bare.headers.get("location")!;
  // With no router headers the expected hash is empty: Next.js redirects to `?_rsc` (no value).
  assert.match(hashed, /[?&]_rsc(=|$)/);
  // The real router request (correct hash): an RSC payload, not cached.
  const rsc = await get(hashed, { RSC: "1" });
  assert.equal(rsc.status, 200);
  assert.match(rsc.headers.get("content-type") ?? "", /text\/x-component/);
  assert.equal(cdn(rsc), "no-store");
  // A forged hash: Next.js redirects here, Vercel (minimal mode) would render; either way uncached.
  const forged = await get("/players?_rsc=forged", { RSC: "1", "next-router-state-tree": "%5B%22%22%5D" });
  assert.equal(cdn(forged), "no-store");
  // HTML requested at a router URL: served, never cached (HTML must never sit under a router key).
  // `?_rsc` with an empty value slips through next.config's has/missing; the proxy's no-store wins.
  for (const url of [hashed, "/players?_rsc=", "/players?_rsc=abc123", "/players?level=aa&_rsc"]) {
    const html = await get(url);
    assert.equal(html.status, 200, url);
    assert.match(html.headers.get("content-type") ?? "", /text\/html/, url);
    // Exactly the proxy's value: for `?_rsc=` the next.config rule matched too, and the proxy won.
    assert.equal(cdn(html), "no-store", url);
  }
  const routerHeaders: Record<string, string>[] = [{ "next-router-prefetch": "1", RSC: "1" }, { "next-router-state-tree": "x" }, { "next-url": "/players" }];
  for (const h of routerHeaders) {
    const r = await get("/players", h);
    assert.equal(cdn(r), "no-store", JSON.stringify(h));
  }
});

test("a refusal is never cached: the proxy's no-store wins over the rule", async () => {
  const profile = /\/players\/[0-9a-f-]{36}/.exec(await (await get("/players?level=aa")).text())![0];
  let refusal: Response | undefined;
  for (let i = 0; i < 200 && !refusal; i++) {
    const r = await get(profile, { "x-vercel-forwarded-for": "203.0.113.200" });
    if (r.status === 429) refusal = r;
    else await r.arrayBuffer();
  }
  assert.ok(refusal, "one client is refused");
  assert.equal(cdn(refusal), "no-store");
  assert.equal(refusal.headers.get("cache-control"), "no-store");
});

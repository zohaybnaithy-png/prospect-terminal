/**
 * Precomputed view models end to end (docs/VERCEL.md, *Precomputed view models*).
 *
 *   npm run test:views:e2e      # ~1–2 min: fictional snapshot + views, `next build`, two `next start`
 *
 * One snapshot build (with views computed by this source tree) is served by two servers that
 * differ ONLY in `PT_PRECOMPUTED_VIEWS`: `off` (every view model computed live, the behaviour
 * before views) and on. Because both run the same build, their responses must be byte-identical:
 * HTML documents, RSC payloads of client navigations, statuses (unknown players stay 404) and
 * headers. Vercel is emulated as in scripts/cdn-cache.e2e.ts (VERCEL=1, unreachable database).
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
import { writeSnapshotViews } from "../src/services/competition/views-build";
import { sourceFingerprint } from "../src/services/competition/views-fingerprint";
import { scaleSnapshot } from "./milb-scale-support";
import { trajectorySnapshot } from "./analytics-test-support";
import type { LevelId } from "../src/services/players/levels";
import type { AflSnapshot } from "../src/services/afl/types";

const ROOT = path.resolve(import.meta.dirname, "..");
const SNAP_DIR = ".data-snapshot-views-e2e";
const NEXT = path.join(ROOT, "node_modules", ".bin", "next");
const UNREACHABLE_DB = "postgresql://nobody:nothing@127.0.0.1:1/none";

interface Server {
  proc: ChildProcess;
  base: string;
  output: string;
}
const servers: Record<"live" | "views", Server> = {} as never;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

const buildEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, PT_DATA_SOURCE: "snapshot", PT_SNAPSHOT_DIR: SNAP_DIR, NEXT_TELEMETRY_DISABLED: "1" };
  delete env.DATABASE_URL;
  delete env.VERCEL;
  delete env.PT_PRECOMPUTED_VIEWS;
  return env;
};

async function start(views: "on" | "off"): Promise<Server> {
  const port = await freePort();
  const server: Server = { proc: undefined as never, base: `http://127.0.0.1:${port}`, output: "" };
  server.proc = spawn(NEXT, ["start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: ROOT,
    env: {
      ...buildEnv(),
      NODE_ENV: "production",
      DATABASE_URL: UNREACHABLE_DB,
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_BRANCH_URL: "pt-git-views-e2e.vercel.app",
      PT_PRECOMPUTED_VIEWS: views,
      PT_DATA_TIMING: "1", // one log line per decoded view part
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.proc.stdout!.on("data", (d) => (server.output += d));
  server.proc.stderr!.on("data", (d) => (server.output += d));
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(`${server.base}/health`)).status === 200) return server;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become ready:\n${server.output}`);
}

before(async () => {
  const levels = new Map<LevelId, AflSnapshot | null>([
    ["afl", trajectorySnapshot()],
    ["aaa", scaleSnapshot({ ns: 1, level: "aaa", teams: 6, days: 40, seed: 1 })],
    ["aa", scaleSnapshot({ ns: 2, level: "aa", teams: 6, days: 40, seed: 2 })],
    ["high-a", scaleSnapshot({ ns: 3, level: "high-a", teams: 6, days: 40, seed: 3 })],
    ["single-a", null],
  ]);
  const dir = path.join(ROOT, SNAP_DIR);
  await writeSnapshotDir(dir, { season: 2026, ingestionVersion: "views-e2e", levels });
  await writeSnapshotViews(dir, { season: 2026, fingerprint: sourceFingerprint(ROOT) });
  const build = spawnSync(NEXT, ["build"], { cwd: ROOT, env: buildEnv(), encoding: "utf8" });
  assert.equal(build.status, 0, `next build failed:\n${build.stdout}\n${build.stderr}`);
  servers.live = await start("off");
  servers.views = await start("on");
});

after(() => {
  for (const s of Object.values(servers)) s?.proc?.kill("SIGTERM");
  rmSync(path.join(ROOT, SNAP_DIR), { recursive: true, force: true });
});

let ip = 10;
const get = (s: Server, url: string, headers: Record<string, string> = {}) =>
  fetch(s.base + url, { redirect: "manual", headers: { "x-vercel-forwarded-for": `198.51.100.${ip++ % 250}`, ...headers } });

/** Response headers that must match (dates and per-request values excluded). */
const HEADERS = ["content-type", "cache-control", "vercel-cdn-cache-control", "content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy", "x-robots-tag", "vary", "location"];

/**
 * RSC payloads only: Next.js keys its metadata/viewport boundary elements with an id that changes on
 * EVERY request, even twice on one server (`["$","$L1a","gXt4X5ZbKGcqibwJRHhn9v",…`). That exact
 * token is replaced; nothing else is normalized. HTML documents are compared raw.
 */
const requestIds = (t: string) => t.replace(/("\$L[0-9a-f]+",")[A-Za-z0-9_-]{21}([vm]")/g, "$1<request-id>$2");

async function compare(url: string, headers: Record<string, string> = {}) {
  const [a, b] = await Promise.all([get(servers.live, url, headers), get(servers.views, url, headers)]);
  const rsc = headers.RSC === "1";
  const [ta, tb] = (await Promise.all([a.text(), b.text()])).map((t) => (rsc ? requestIds(t) : t));
  assert.equal(b.status, a.status, `${url}: status`);
  for (const h of HEADERS) assert.equal(b.headers.get(h), a.headers.get(h), `${url}: ${h}`);
  assert.ok(ta.length > 0 || (a.status >= 300 && a.status < 400), `${url}: body`);
  if (tb !== ta) {
    const i = [...ta].findIndex((c, k) => tb[k] !== c);
    assert.fail(`${url}: bodies differ at ${i}: …${ta.slice(Math.max(0, i - 80), i + 80)}… vs …${tb.slice(Math.max(0, i - 80), i + 80)}…`);
  }
  return { status: a.status, bytes: ta.length, location: a.headers.get("location") };
}

test("the servers differ only in PT_PRECOMPUTED_VIEWS, and say so", () => {
  assert.match(servers.views.output, /\[competition-views\] precomputed views on \(snapshot [0-9a-f]{12}, 4 levels\)/);
  assert.match(servers.live.output, /\[competition-views\] precomputed views off: PT_PRECOMPUTED_VIEWS is not on; computing live/);
});

test("HTML documents are byte-identical with and without views", async () => {
  const html = await (await get(servers.live, "/players?level=aa")).text();
  const profile = /\/players\/[0-9a-f-]{36}/.exec(html)![0];
  const urls = [
    "/",
    "/?level=afl",
    "/?level=aaa",
    "/?level=aa",
    "/?level=high-a",
    "/?level=single-a",
    "/players",
    "/players?role=pitchers",
    "/players?window=7d",
    "/players?window=30d&role=pitchers",
    "/players?level=aaa",
    "/players?level=aa&window=14d",
    "/players?level=high-a&role=pitchers&sort=mom&dir=desc",
    "/players?level=aa&q=hitter%202-1",
    "/players?page=2",
    "/players?level=afl",
    "/trends",
    "/trends?level=aaa",
    "/trends?level=aa",
    "/trends?level=high-a",
    "/trends?level=single-a",
    "/data",
    profile,
    `${profile}?level=aa`,
    "/trends/data?view=map&level=aa&role=pitcher&window=30d",
    "/trends/data?view=risers&level=high-a&role=hitter&window=7d",
    "/trends/data?view=map&level=single-a&role=hitter&window=14d",
  ];
  for (const url of urls) assert.equal((await compare(url)).status, url.includes("single-a") && url.startsWith("/trends/data") ? 404 : 200, url);
});

test("unknown players are still HTTP 404, identically", async () => {
  for (const url of ["/players/00000000-0000-4000-8000-000000000000", "/players/not-a-uuid", "/players/00000000-0000-4000-8000-000000000000?level=aa"])
    assert.equal((await compare(url)).status, 404, url);
});

test("RSC payloads of client navigations are byte-identical", async () => {
  for (const url of ["/", "/?level=high-a", "/players", "/players?level=aa&window=7d", "/trends?level=aaa", "/data"]) {
    // Next.js redirects a bare RSC request to its `_rsc` URL; both servers compute the same one.
    const bare = await compare(url, { RSC: "1" });
    assert.equal(bare.status, 307, url);
    const hashed = new URL(bare.location!, "http://x");
    const r = await compare(hashed.pathname + hashed.search, { RSC: "1" });
    assert.equal(r.status, 200, url);
  }
});

test("views were really used: the views server decoded the parts the pages need; nothing fell back", () => {
  const decoded = new Set([...servers.views.output.matchAll(/\[competition-views\] ([a-z-]+) ([a-z0-9|-]+): \d+ B in/g)].map((m) => `${m[1]} ${m[2]}`));
  for (const p of [
    "aa directory-rows|aa|season",
    "aaa directory-rows|aaa|season",
    "high-a directory-rows|high-a|season",
    "aa directory-rows|aa|7d",
    "aa home-trending",
    "aa home-top-lines",
    "aa level-move-spans",
    "aaa coverage",
    "aa trend-comparable",
    "aa trend-riser-lists",
    "aa trend-map-points|hitter|14d",
    "aa trend-map-points|pitcher|30d",
  ])
    assert.ok(decoded.has(p), `${p} decoded (got ${[...decoded].join(", ")})`);
  assert.doesNotMatch(servers.live.output, /\[competition-views\] [a-z-]+ [a-z0-9|-]+: \d+ B in/, "the live server decodes nothing");
  assert.doesNotMatch(servers.views.output, /computing live|cannot be decoded|integrity check failed/);
  assert.doesNotMatch(servers.views.output + servers.live.output, /\[db\]|ECONNREFUSED|load failed/, "no database access");
});

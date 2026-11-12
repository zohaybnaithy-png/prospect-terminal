/**
 * Client navigation against a REAL production build in a real browser (Phase 2A, docs/VERCEL.md
 * *Navigation*): the router cache (`staleTimes.dynamic`, next.config.ts) and the inline pending
 * hint (src/components/ui/link-pending-hint.tsx).
 *
 *   npm run test:nav:e2e        # ~3–4 min: two fictional snapshot builds, `next start`, headless Chromium
 *
 * What it proves, through Next.js's real router, proxy and header layers (Vercel emulated with
 * VERCEL=1 and an unreachable DATABASE_URL, as in scripts/cdn-cache.e2e.ts):
 * - first visit to a page = one RSC request; revisits within the stale time, Back and Forward = none;
 *   hovering a link = none (prefetch stays off);
 * - query parameters, directory filters, search and the selected level stay consistent with what is
 *   rendered across cached navigations and history;
 * - the pending hint appears only after its delay on a slow navigation, never shifts layout, and
 *   never flashes on cached navigations;
 * - unknown player profiles still answer HTTP 404, security and CDN headers are unchanged;
 * - after a new deployment on the same origin, cached pages are at most stale (no errors), and the
 *   first navigation that reaches the server loads the new build as a full document.
 *
 * Browser: Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH, or NAV_E2E_BROWSER for an executable).
 * Leaves `.next/` holding a snapshot build: run `npm run build` afterwards for a normal build.
 * Uses only fictional fixture data; never touches a database.
 */
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Request } from "playwright-core";
import { writeSnapshotDir } from "../src/services/competition/snapshot-store";
import { CDN_CACHE_VALUE } from "../src/lib/cdn-cache";
import { scaleSnapshot } from "./milb-scale-support";
import { trajectorySnapshot } from "./analytics-test-support";
import type { LevelId } from "../src/services/players/levels";
import type { AflSnapshot } from "../src/services/afl/types";

const ROOT = path.resolve(import.meta.dirname, "..");
const SNAP_DIR = ".data-snapshot-nav-e2e";
const NEXT = path.join(ROOT, "node_modules", ".bin", "next");
const UNREACHABLE_DB = "postgresql://nobody:nothing@127.0.0.1:1/none";

let server: ChildProcess | undefined;
let browser: Browser | undefined;
let port = 0;
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

/** Build "deployment" A or B: same shape, different AA players (namespace 2 vs 7). */
async function build(deployment: "A" | "B") {
  const levels = new Map<LevelId, AflSnapshot | null>([
    ["afl", trajectorySnapshot()],
    ["aaa", scaleSnapshot({ ns: 1, level: "aaa", teams: 6, days: 30, seed: 1 })],
    ["aa", scaleSnapshot({ ns: deployment === "A" ? 2 : 7, level: "aa", teams: 6, days: 30, seed: 2 })],
    ["high-a", scaleSnapshot({ ns: 3, level: "high-a", teams: 6, days: 30, seed: 3 })],
    ["single-a", null],
  ]);
  rmSync(path.join(ROOT, SNAP_DIR), { recursive: true, force: true });
  await writeSnapshotDir(path.join(ROOT, SNAP_DIR), { season: 2026, ingestionVersion: `nav-e2e-${deployment}`, levels });
  const r = spawnSync(NEXT, ["build"], { cwd: ROOT, env: buildEnv(), encoding: "utf8" });
  assert.equal(r.status, 0, `next build (${deployment}) failed:\n${r.stdout}\n${r.stderr}`);
}

function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PT_DATA_SOURCE: "snapshot", PT_SNAPSHOT_DIR: SNAP_DIR, NEXT_TELEMETRY_DISABLED: "1" };
  delete env.DATABASE_URL;
  delete env.VERCEL;
  return env;
}

async function start() {
  output = "";
  server = spawn(NEXT, ["start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: ROOT,
    env: {
      ...buildEnv(),
      NODE_ENV: "production",
      DATABASE_URL: UNREACHABLE_DB, // must never be used in snapshot mode
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_BRANCH_URL: "pt-git-nav-e2e.vercel.app",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.on("data", (d) => (output += d));
  server.stderr!.on("data", (d) => (output += d));
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.status === 200) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become ready:\n${output}`);
}

async function stop() {
  const s = server;
  server = undefined;
  if (!s || s.exitCode !== null) return;
  const exited = new Promise((r) => s.once("exit", r));
  s.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  if (s.exitCode === null) s.kill("SIGKILL");
}

before(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await build("A");
  await start();
  browser = await chromium.launch(process.env.NAV_E2E_BROWSER ? { executablePath: process.env.NAV_E2E_BROWSER } : {});
});

after(async () => {
  await browser?.close();
  await stop();
  rmSync(path.join(ROOT, SNAP_DIR), { recursive: true, force: true });
});

// ---- helpers ------------------------------------------------------------------------------------

let ip = 10;
interface Tracked {
  page: Page;
  ctx: BrowserContext;
  /** Server requests since the last reset (static assets excluded). */
  requests: { path: string; search: string; rsc: boolean; prefetch: boolean; document: boolean }[];
  errors: string[];
  reset(): void;
}

/** A fresh browser context with its own client address (rate limits stay per test) and a request log. */
async function open(): Promise<Tracked> {
  const ctx = await browser!.newContext({
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { "x-vercel-forwarded-for": `198.51.100.${ip++ % 250}` },
  });
  // tsx compiles with esbuild keepNames, which wraps functions passed to page.evaluate in __name().
  await ctx.addInitScript("window.__name = (f) => f;");
  const page = await ctx.newPage();
  const t: Tracked = {
    page,
    ctx,
    requests: [],
    errors: [],
    reset() {
      t.requests = [];
    },
  };
  page.on("request", (r: Request) => {
    const u = new URL(r.url());
    if (u.origin !== base || u.pathname.startsWith("/_next/") || u.pathname.startsWith("/_vercel/") || u.pathname === "/favicon.ico") return;
    const h = r.headers();
    t.requests.push({ path: u.pathname, search: u.search, rsc: h["rsc"] === "1", prefetch: !!h["next-router-prefetch"], document: r.resourceType() === "document" });
  });
  page.on("pageerror", (e) => t.errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // Vercel Web Analytics' script exists only on Vercel; locally /_vercel/insights is a 404.
    if (m.type() === "error" && !/\/_vercel\//.test(`${m.location().url} ${m.text()}`)) t.errors.push(`console: ${m.text()}`);
  });
  return t;
}

const tab = (page: Page, name: string) => page.locator("nav[aria-label='Main navigation'] a", { hasText: name });
const pathIs = (p: string) => (u: URL) => u.pathname === p;
/** Let any trailing router work (and a would-be request) happen before counting. */
const settle = (page: Page) => page.waitForTimeout(250);

async function clickTo(t: Tracked, link: ReturnType<Page["locator"]>, url: (u: URL) => boolean) {
  await link.click();
  await t.page.waitForURL(url);
  await t.page.waitForLoadState("networkidle");
  await settle(t.page);
}

/** What the directory renders, read from the page (not from the URL). */
async function directoryState(page: Page) {
  return page.evaluate(() => {
    const current = (label: string) =>
      document.querySelector(`nav[aria-label='${label}'] a[aria-current='page']`)?.textContent?.trim() ?? null;
    const names = [...document.querySelectorAll("a.player-name")].map((a) => a.textContent!.trim());
    return {
      role: current("Hitters or pitchers"),
      level: current("Level"),
      q: (document.querySelector("input[type=search][name=q]") as HTMLInputElement | null)?.value ?? null,
      names,
    };
  });
}

/** The directory is consistent with its URL: role, level and search field match, rows match. */
async function assertDirectoryMatchesUrl(page: Page, label: string) {
  const u = new URL(page.url());
  const s = await directoryState(page);
  const role = u.searchParams.get("role") === "pitchers" ? "Pitchers" : "Hitters";
  assert.equal(s.role, role, `${label}: role`);
  const levelShort: Record<string, string> = { "": "All levels", afl: "AFL", aaa: "AAA", aa: "AA", "high-a": "A+", "single-a": "A" };
  assert.equal(s.level, levelShort[u.searchParams.get("level") ?? ""], `${label}: level (${u.search})`);
  assert.equal(s.q, u.searchParams.get("q") ?? "", `${label}: search field`);
  assert.ok(s.names.length > 0, `${label}: rows rendered`);
  // Fixture names encode level and role: "Hitter 2-…" is an AA hitter (namespace 2), "Pitcher 1-…" AAA.
  const ns: Record<string, string> = { aaa: "1", aa: "2", "high-a": "3" };
  const lvl = u.searchParams.get("level");
  if (lvl && ns[lvl]) {
    const prefix = `${role === "Pitchers" ? "Pitcher" : "Hitter"} ${ns[lvl]}-`;
    for (const n of s.names) assert.ok(n.startsWith(prefix), `${label}: "${n}" is not a ${prefix} row`);
  }
  const q = u.searchParams.get("q");
  if (q) for (const n of s.names) assert.ok(n.toLowerCase().includes(q.toLowerCase()), `${label}: "${n}" does not match q=${q}`);
  return s;
}

/** Highest computed opacity of any pending hint observed (per animation frame) until stopped. */
async function watchHint(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __hint: { max: number; pendingSeen: boolean; on: boolean } };
    w.__hint = { max: 0, pendingSeen: false, on: true };
    const tick = () => {
      if (!w.__hint.on) return;
      for (const el of document.querySelectorAll(".link-hint")) {
        if (el.getAttribute("data-pending") === "true") w.__hint.pendingSeen = true;
        w.__hint.max = Math.max(w.__hint.max, Number(getComputedStyle(el).opacity));
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return async () =>
    page.evaluate(() => {
      const w = window as unknown as { __hint: { max: number; pendingSeen: boolean; on: boolean } };
      w.__hint.on = false;
      return { max: w.__hint.max, pendingSeen: w.__hint.pendingSeen };
    });
}

const rscRequests = (t: Tracked) => t.requests.filter((r) => r.rsc && !r.prefetch);
/** Request URLs for assertion messages (a copy: deepEqual narrows its argument). */
const seen = (t: Tracked) => t.requests.map((r) => `${r.path}${r.search}${r.rsc ? " [rsc]" : ""}`);

// ---- tests --------------------------------------------------------------------------------------

describe("router cache", () => {
  test("first visit = one RSC request; hover, cached revisits, Back and Forward = none", async () => {
    const t = await open();
    try {
      await t.page.goto(`${base}/`, { waitUntil: "networkidle" });

      t.reset();
      await tab(t.page, "Players").hover();
      await t.page.waitForTimeout(600);
      assert.deepEqual(seen(t), [], "hovering a link makes no request (prefetch off)");

      t.reset();
      await clickTo(t, tab(t.page, "Players"), pathIs("/players"));
      assert.deepEqual(rscRequests(t).map((r) => r.path), ["/players"], "first visit: exactly one RSC request");
      assert.equal(t.requests.filter((r) => r.prefetch).length, 0, "no prefetch requests");

      t.reset();
      await clickTo(t, tab(t.page, "Trends"), pathIs("/trends"));
      assert.deepEqual(rscRequests(t).map((r) => r.path), ["/trends"]);

      // Revisits within the stale time: served from the router cache, no server request.
      for (const [name, p] of [["Home", "/"], ["Players", "/players"], ["Trends", "/trends"]] as const) {
        t.reset();
        const start = Date.now();
        await tab(t.page, name).hover();
        await clickTo(t, tab(t.page, name), pathIs(p));
        assert.deepEqual(seen(t), [], `cached revisit of ${p} makes no request`);
        assert.ok(Date.now() - start < 2000, `cached revisit of ${p} is immediate`);
      }

      // Back / Forward through the history built above.
      for (const [dir, p] of [["back", "/players"], ["back", "/"], ["forward", "/players"], ["forward", "/trends"]] as const) {
        t.reset();
        await (dir === "back" ? t.page.goBack() : t.page.goForward());
        await t.page.waitForURL(pathIs(p));
        await settle(t.page);
        assert.deepEqual(seen(t), [], `${dir} to ${p} makes no request`);
      }
      // Rendered content belongs to the URL after history moves: same heading as a fresh load.
      const cachedHeading = await t.page.locator("h1").first().textContent();
      const fresh = await open();
      try {
        await fresh.page.goto(`${base}/trends`, { waitUntil: "networkidle" });
        assert.equal(cachedHeading, await fresh.page.locator("h1").first().textContent());
      } finally {
        await fresh.ctx.close();
      }
      assert.deepEqual([...t.errors], []);
    } finally {
      await t.ctx.close();
    }
  });

  test("query parameters, filters, search and the selected level stay correct across cached navigation", async () => {
    const t = await open();
    try {
      await t.page.goto(`${base}/players?level=aa`, { waitUntil: "networkidle" });
      await assertDirectoryMatchesUrl(t.page, "initial AA");
      const levels = t.page.locator("nav[aria-label='Level'] a");
      const roles = t.page.locator("nav[aria-label='Hitters or pitchers'] a");

      t.reset();
      await clickTo(t, levels.filter({ hasText: /^AAA$/ }), (u) => u.searchParams.get("level") === "aaa");
      assert.equal(rscRequests(t).length, 1, "a new query string is a new cache entry");
      await assertDirectoryMatchesUrl(t.page, "AAA");

      await clickTo(t, roles.filter({ hasText: "Pitchers" }), (u) => u.searchParams.get("role") === "pitchers");
      await assertDirectoryMatchesUrl(t.page, "AAA pitchers");

      // Search (debounced router navigation) keeps role and level.
      const aaaPitcher = (await directoryState(t.page)).names[0]!;
      const q = aaaPitcher.split(" ").slice(0, 2).join(" ").slice(0, 10);
      await t.page.locator("input[type=search][name=q]").fill(q);
      await t.page.waitForURL((u) => u.searchParams.get("q") === q);
      await t.page.waitForLoadState("networkidle");
      await settle(t.page);
      const searched = await assertDirectoryMatchesUrl(t.page, "AAA pitchers + search");
      assert.equal(new URL(t.page.url()).searchParams.get("level"), "aaa");
      assert.ok(searched.names.includes(aaaPitcher));

      // Team filter (router.push from a <select>) keeps the other scopes.
      await t.page.locator("button.filters-toggle").click().catch(() => {});
      const team = t.page.locator("select[name=team]");
      const teamId = await team.locator("option").nth(1).getAttribute("value");
      await team.selectOption(teamId!);
      await t.page.waitForURL((u) => u.searchParams.has("team"));
      await t.page.waitForLoadState("networkidle");
      await settle(t.page);
      const filtered = new URL(t.page.url()).searchParams;
      assert.equal(filtered.get("level"), "aaa");
      assert.equal(filtered.get("role"), "pitchers");
      await assertDirectoryMatchesUrl(t.page, "AAA pitchers + search + team");

      // Back to an AA hitter list that is in the cache: no request, AA rows, not AAA.
      await t.page.goto(`${base}/players?level=aa`, { waitUntil: "networkidle" });
      await clickTo(t, levels.filter({ hasText: /^AAA$/ }), (u) => u.searchParams.get("level") === "aaa");
      t.reset();
      await clickTo(t, levels.filter({ hasText: /^AA$/ }), (u) => u.searchParams.get("level") === "aa");
      assert.deepEqual(seen(t), [], "AA revisit is cached");
      await assertDirectoryMatchesUrl(t.page, "cached AA revisit");
      t.reset();
      await clickTo(t, levels.filter({ hasText: /^AAA$/ }), (u) => u.searchParams.get("level") === "aaa");
      assert.deepEqual(seen(t), [], "AAA revisit is cached");
      await assertDirectoryMatchesUrl(t.page, "cached AAA revisit");

      // History through every scope change: each entry renders its own URL's content.
      for (let i = 0; i < 3; i++) {
        await t.page.goBack();
        await t.page.waitForLoadState("networkidle");
        await settle(t.page);
        await assertDirectoryMatchesUrl(t.page, `back #${i + 1} (${new URL(t.page.url()).search})`);
      }
      for (let i = 0; i < 3; i++) {
        await t.page.goForward();
        await t.page.waitForLoadState("networkidle");
        await settle(t.page);
        await assertDirectoryMatchesUrl(t.page, `forward #${i + 1} (${new URL(t.page.url()).search})`);
      }

      // A level carried into a profile link and back.
      const profile = t.page.locator("a.player-name").first();
      const href = (await profile.getAttribute("href"))!;
      assert.match(href, /\?level=aaa$/);
      await clickTo(t, profile, (u) => u.pathname === href.split("?")[0]);
      assert.equal(new URL(t.page.url()).searchParams.get("level"), "aaa");
      t.reset();
      await t.page.goBack();
      await t.page.waitForURL((u) => u.pathname === "/players");
      await settle(t.page);
      assert.deepEqual(seen(t), []);
      await assertDirectoryMatchesUrl(t.page, "back from profile");
      assert.deepEqual([...t.errors], []);
    } finally {
      await t.ctx.close();
    }
  });
});

describe("pending hint", () => {
  test("slow navigation: hidden for its delay, then visible, no layout shift, gone on arrival", async () => {
    const t = await open();
    try {
      await t.page.goto(`${base}/`, { waitUntil: "networkidle" });
      // Hold RSC responses for /data to simulate a slow (cold) server.
      let release: () => void = () => {};
      const held = new Promise<void>((r) => (release = r));
      await t.page.route(
        (u) => u.pathname === "/data",
        async (route) => {
          if (route.request().headers()["rsc"] === "1") await held;
          await route.continue();
        },
      );
      const link = tab(t.page, "Data");
      const hint = link.locator(".link-hint");
      const before = await link.boundingBox();
      const navBefore = await t.page.locator("nav[aria-label='Main navigation']").boundingBox();
      assert.equal(await hint.getAttribute("data-pending"), "false");

      await link.click();
      await t.page.waitForFunction(() => document.querySelector("nav[aria-label='Main navigation'] a[href='/data'] .link-hint")?.getAttribute("data-pending") === "true");
      assert.equal(Number(await hint.evaluate((el) => getComputedStyle(el).opacity)), 0, "not shown before the delay");
      await t.page.waitForTimeout(400);
      assert.equal(Number(await hint.evaluate((el) => getComputedStyle(el).opacity)), 1, "shown after the delay");
      assert.equal(await hint.getAttribute("aria-hidden"), "true");
      assert.deepEqual(await link.boundingBox(), before, "the link does not move or resize");
      assert.deepEqual(await t.page.locator("nav[aria-label='Main navigation']").boundingBox(), navBefore, "the nav does not shift");
      assert.equal(new URL(t.page.url()).pathname, "/", "still on the old page while pending");

      release();
      await t.page.waitForURL(pathIs("/data"));
      await t.page.waitForLoadState("networkidle");
      await settle(t.page);
      assert.equal(await hint.getAttribute("data-pending"), "false");
      assert.equal(Number(await hint.evaluate((el) => getComputedStyle(el).opacity)), 0);
      assert.deepEqual([...t.errors], []);
    } finally {
      await t.ctx.close();
    }
  });

  test("player-name links show the hint while a slow profile loads", async () => {
    const t = await open();
    try {
      await t.page.goto(`${base}/players?level=aa`, { waitUntil: "networkidle" });
      let release: () => void = () => {};
      const held = new Promise<void>((r) => (release = r));
      await t.page.route(
        (u) => u.pathname.startsWith("/players/"),
        async (route) => {
          if (route.request().headers()["rsc"] === "1") await held;
          await route.continue();
        },
      );
      const link = t.page.locator("a.player-name").first();
      const before = await link.boundingBox();
      await link.click();
      await t.page.waitForTimeout(400);
      assert.equal(await link.locator(".link-hint").getAttribute("data-pending"), "true");
      assert.equal(Number(await link.locator(".link-hint").evaluate((el) => getComputedStyle(el).opacity)), 1);
      assert.deepEqual(await link.boundingBox(), before);
      release();
      await t.page.waitForURL((u) => u.pathname.startsWith("/players/") && u.pathname !== "/players");
      assert.deepEqual([...t.errors], []);
    } finally {
      await t.ctx.close();
    }
  });

  test("cached navigations never visibly flash the hint", async () => {
    const t = await open();
    try {
      await t.page.goto(`${base}/`, { waitUntil: "networkidle" });
      await clickTo(t, tab(t.page, "Players"), pathIs("/players"));
      await clickTo(t, tab(t.page, "Trends"), pathIs("/trends"));
      const done = await watchHint(t.page);
      t.reset();
      for (const [name, p] of [["Home", "/"], ["Players", "/players"], ["Trends", "/trends"], ["Players", "/players"]] as const) {
        await clickTo(t, tab(t.page, name), pathIs(p));
      }
      await t.page.goBack();
      await settle(t.page);
      const hint = await done();
      assert.deepEqual(seen(t), [], "all cached");
      assert.equal(hint.max, 0, `hint opacity stayed 0 (pending seen: ${hint.pendingSeen})`);
    } finally {
      await t.ctx.close();
    }
  });
});

describe("responses unchanged", () => {
  test("unknown player profiles answer HTTP 404, before and after cached navigation", async () => {
    const t = await open();
    try {
      for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
        const r = await t.page.goto(`${base}/players/${id}`);
        assert.equal(r?.status(), 404, id);
      }
      await t.page.goto(`${base}/players`, { waitUntil: "networkidle" });
      await clickTo(t, tab(t.page, "Home"), pathIs("/"));
      await clickTo(t, tab(t.page, "Players"), pathIs("/players"));
      const r = await t.page.goto(`${base}/players/00000000-0000-4000-8000-000000000000`);
      assert.equal(r?.status(), 404, "a document load after cached navigation is still a real 404");
      assert.match((await t.page.locator("main").textContent()) ?? "", /not found/i);
    } finally {
      await t.ctx.close();
    }
  });

  test("security headers and CDN rules are exactly the configured ones", async () => {
    // The server runs with NODE_ENV=production; evaluate next.config the same way (CSP differs in dev).
    const env = process.env as Record<string, string | undefined>;
    const nodeEnv = env.NODE_ENV;
    env.NODE_ENV = "production";
    const { default: nextConfig } = await import("../next.config");
    env.NODE_ENV = nodeEnv;
    const rules = await nextConfig("phase-production-server").headers!();
    const security = rules.find((r) => r.source === "/:path*" && r.headers.some((h) => h.key === "Content-Security-Policy"));
    assert.ok(security, "security header rule present");
    const t = await open();
    try {
      for (const url of ["/", "/players?level=aa", "/trends"]) {
        const r = await t.page.goto(base + url);
        const h = await r!.allHeaders();
        assert.equal(r!.status(), 200, url);
        for (const { key, value } of security.headers) assert.equal(h[key.toLowerCase()], value, `${url}: ${key}`);
        assert.equal(h["vercel-cdn-cache-control"], CDN_CACHE_VALUE, url);
      }
      // Router requests are never CDN-cached and carry the same security headers.
      const rsc: Record<string, string>[] = [];
      t.page.on("response", async (res) => {
        if (res.request().headers()["rsc"] === "1") rsc.push(await res.allHeaders());
      });
      await clickTo(t, tab(t.page, "Data"), pathIs("/data"));
      assert.equal(rsc.length, 1);
      assert.equal(rsc[0]!["vercel-cdn-cache-control"], "no-store");
      assert.equal(rsc[0]!["x-frame-options"], "DENY");
      assert.match(rsc[0]!["content-security-policy"] ?? "", /default-src/);
    } finally {
      await t.ctx.close();
    }
  });
});

describe("new deployment", () => {
  test("cached pages stay boundedly stale; the next server navigation loads the new build", { timeout: 600_000 }, async () => {
    const t = await open();
    try {
      const aa = () => t.page.locator("nav[aria-label='Level'] a").filter({ hasText: /^AA$/ });
      const isAa = (u: URL) => u.pathname === "/players" && u.searchParams.get("level") === "aa";
      await t.page.goto(`${base}/`, { waitUntil: "networkidle" });
      await clickTo(t, tab(t.page, "Players"), pathIs("/players"));
      await clickTo(t, aa(), isAa);
      const namesA = (await directoryState(t.page)).names;
      assert.ok(namesA.length > 0 && namesA.every((n) => /^Hitter 2-/.test(n)), "deployment A: AA namespace 2");
      await clickTo(t, tab(t.page, "Home"), pathIs("/"));

      // Redeploy on the same origin: stop A, build B (different AA players), start B.
      await stop();
      await build("B");
      await start();
      t.errors = [];

      // Cached revisits: no request, the old deployment's pages (at most the stale time old).
      t.reset();
      await clickTo(t, tab(t.page, "Players"), pathIs("/players"));
      await clickTo(t, aa(), isAa);
      assert.deepEqual(seen(t), [], "cached pages served without a request");
      assert.deepEqual((await directoryState(t.page)).names, namesA, "cached = old deployment's content");

      // First navigation that reaches the server: Next.js sees a different build and loads a full
      // document from the new deployment instead of mixing builds.
      t.reset();
      await tab(t.page, "Data").click();
      await t.page.waitForURL(pathIs("/data"));
      await t.page.waitForLoadState("networkidle");
      await settle(t.page);
      assert.ok(t.requests.some((r) => r.document && r.path === "/data"), `full document load: ${JSON.stringify(seen(t))}`);

      // After the reload the router cache is empty: AA now comes from deployment B.
      t.reset();
      await clickTo(t, tab(t.page, "Players"), pathIs("/players"));
      await clickTo(t, aa(), isAa);
      assert.equal(rscRequests(t).length, 2, `fresh router cache after the new build loaded: ${JSON.stringify(seen(t))}`);
      const namesB = (await directoryState(t.page)).names;
      assert.ok(namesB.length > 0 && namesB.every((n) => /^Hitter 7-/.test(n)), "deployment B's data, no deployment A rows");
      assert.deepEqual(t.errors.filter((e) => !/Failed to load resource/.test(e)), [], "no client errors across the deployment change");
    } finally {
      await t.ctx.close();
    }
  });
});

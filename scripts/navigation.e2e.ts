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
async function open({ javaScriptEnabled = true } = {}): Promise<Tracked> {
  const ctx = await browser!.newContext({
    javaScriptEnabled,
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

describe("player comparison", () => {
  test("profile → Add to compare → compare page shows the player; a pasted profile link adds another", async () => {
    const t = await open();
    try {
      await t.page.goto(`${base}/players?level=aa`, { waitUntil: "networkidle" });
      const links = t.page.locator("a.player-name");
      const hrefs = [await links.nth(0).getAttribute("href"), await links.nth(1).getAttribute("href")];
      const names = [(await links.nth(0).textContent())!.trim(), (await links.nth(1).textContent())!.trim()];
      const ids = hrefs.map((h) => new URL(h!, base).pathname.split("/").pop()!);
      await clickTo(t, links.nth(0), pathIs(`/players/${ids[0]}`));

      t.reset();
      await clickTo(t, t.page.getByRole("link", { name: "Add to compare" }), pathIs("/compare"));
      assert.deepEqual(rscRequests(t).map((r) => r.path), ["/compare"], "client navigation, one RSC request");
      const u = new URL(t.page.url());
      assert.deepEqual([u.searchParams.get("level"), u.searchParams.get("ids"), u.searchParams.get("role")], ["aa", ids[0], null]);
      const main = () => t.page.locator("main").textContent();
      assert.match((await main()) ?? "", new RegExp(`Add at least 2 players to compare\\.\\s*So far: ${names[0]}`));

      // No JavaScript needed: a plain GET form, answered as a full document.
      await t.page.fill("#compare-add", `${base}${hrefs[1]}`);
      await Promise.all([t.page.waitForURL((x) => x.searchParams.has("add")), t.page.click("form.compare-add button[type=submit]")]);
      await t.page.waitForLoadState("networkidle");
      const columns = await t.page.locator("table.compare-table thead th.compare-player a.player-name").allTextContents();
      assert.deepEqual(columns.map((c) => c.trim()), names);
      assert.ok((await t.page.locator("table.compare-table td.best").count()) > 0, "best values marked");
      // Removing a player is a plain link back to the one-player state.
      await clickTo(t, t.page.getByRole("link", { name: `Remove ${names[1]} from the comparison` }), (x) => x.searchParams.get("ids") === ids[0]);
      assert.match((await main()) ?? "", /Add at least 2 players/);
      assert.deepEqual([...t.errors], []);
    } finally {
      await t.ctx.close();
    }
  });

  test("directory → tick two players → Compare selected: client navigation; picks survive paging; max 4", async () => {
    const t = await open();
    try {
      await t.page.goto(`${base}/players?level=aa&size=50`, { waitUntil: "networkidle" });
      const boxes = t.page.locator("input.compare-pick");
      const ids = [await boxes.nth(0).getAttribute("value"), await boxes.nth(1).getAttribute("value")];
      await boxes.nth(0).check();
      const button = t.page.getByRole("button", { name: "Compare selected" });
      assert.equal(await button.isDisabled(), true, "one pick is not a comparison");
      // A pick on page 2 joins the pick from page 1.
      await clickTo(t, t.page.getByRole("link", { name: "Next →" }), (u) => u.searchParams.get("page") === "2");
      const later = await boxes.nth(0).getAttribute("value");
      await boxes.nth(0).check();
      await boxes.nth(1).check();
      await boxes.nth(2).check();
      assert.equal(await boxes.nth(3).isDisabled(), true, `no more than 4 picks`);
      await boxes.nth(2).uncheck();
      assert.equal(await boxes.nth(3).isDisabled(), false, "unticking frees a place");
      const page2 = [later, await boxes.nth(1).getAttribute("value")];
      t.reset();
      await clickTo(t, button, pathIs("/compare"));
      assert.deepEqual(rscRequests(t).map((r) => r.path), ["/compare"], "client navigation, one RSC request");
      const u = new URL(t.page.url());
      assert.deepEqual([u.searchParams.get("level"), u.searchParams.get("ids")], ["aa", [ids[0], ...page2].join(",")]);
      assert.equal(await t.page.locator("table.compare-table thead th.compare-player").count(), 3);
      // Changing the role clears the picks: a comparison is one level and one role.
      await t.page.goto(`${base}/players?level=aa`, { waitUntil: "networkidle" });
      await boxes.nth(0).check();
      await clickTo(t, t.page.getByRole("link", { name: "Pitchers" }).first(), (x) => x.searchParams.get("role") === "pitchers");
      assert.equal(await t.page.locator("input.compare-pick:checked").count(), 0);
      assert.ok(ids[1]);
      assert.deepEqual([...t.errors], []);
    } finally {
      await t.ctx.close();
    }
  });

  test("the directory compare form is a plain GET to /compare; /compare reads one ids field per ticked row", async () => {
    // Form semantics from the server HTML (what a browser submits without the client handler).
    const html = await (await fetch(`${base}/players?level=aa&role=pitchers`, { headers: { "x-vercel-forwarded-for": "198.51.100.252" } })).text();
    const form = html.match(/<form[^>]*id="directory-compare"[^>]*>[\s\S]*?<\/form>/)?.[0] ?? "";
    assert.match(form, /action="\/compare"/);
    assert.match(form, /method="get"/);
    assert.match(form, /<input type="hidden" name="level" value="aa"\/>/);
    assert.match(form, /<input type="hidden" name="role" value="pitchers"\/>/);
    const ids = [...html.matchAll(/<input[^>]*class="compare-pick"[^>]*>/g)].map((m) => {
      assert.match(m[0], /form="directory-compare"/);
      assert.match(m[0], /name="ids"/);
      return m[0].match(/value="([^"]+)"/)![1];
    });
    assert.ok(ids.length >= 2, "pick boxes rendered");
    // That submission, answered without JavaScript.
    const t = await open({ javaScriptEnabled: false });
    try {
      const r = await t.page.goto(`${base}/compare?level=aa&role=pitchers&ids=${ids[0]}&ids=${ids[1]}`);
      assert.equal(r?.status(), 200);
      assert.equal(await t.page.locator("table.compare-table thead th.compare-player").count(), 2);
    } finally {
      await t.ctx.close();
    }
    // All levels: no pick column, a pointer to choose a level instead.
    const all = await (await fetch(`${base}/players`, { headers: { "x-vercel-forwarded-for": "198.51.100.253" } })).text();
    assert.ok(!all.includes("compare-pick"));
    assert.match(all, /Choose a level to compare players side by side\./);
  });

  test("bad comparison input is a notice on a 200 page, never a 404", async () => {
    const t = await open();
    try {
      const r = await t.page.goto(`${base}/compare?level=nope&ids=not-a-uuid`);
      assert.equal(r?.status(), 200);
      assert.match((await t.page.locator("main").textContent()) ?? "", /not recognised[\s\S]*1 invalid player id was ignored/);
    } finally {
      await t.ctx.close();
    }
  });
});

describe("without JavaScript", () => {
  // Streamed <Suspense> content is parked in <div hidden id="S:…"> until a script moves it, so with
  // JavaScript off those pages showed only "Loading…". Pages render in place instead.
  test("every main page shows its content, with no hidden streamed blocks", async () => {
    const t = await open({ javaScriptEnabled: false });
    try {
      const pages: [string, string][] = [
        ["/", "main"],
        ["/players?level=aa", "table.data-table tbody tr"],
        ["/trends?level=aa", "main h2"],
        ["/data", "#coverage"],
        ["/compare", "main"],
      ];
      for (const [url, selector] of pages) {
        const r = await t.page.goto(`${base}${url}`);
        assert.equal(r?.status(), 200, url);
        const html = await t.page.content();
        assert.doesNotMatch(html, /<div hidden="?"? id="S:/, `${url}: streamed block left hidden`);
        assert.doesNotMatch(html, /Loading (players|trends|prospect data|coverage|scores)…/, `${url}: loading placeholder`);
        assert.ok(await t.page.locator(selector).first().isVisible(), `${url}: ${selector} visible`);
      }
    } finally {
      await t.ctx.close();
    }
  });

  test("directory search (Apply) and compare picks work with real clicks", async () => {
    const t = await open({ javaScriptEnabled: false });
    try {
      await t.page.goto(`${base}/players?level=aa`);
      const first = (await t.page.locator("a.player-name").first().textContent())!.trim();
      await t.page.fill(".directory-search input[name=q]", first);
      await Promise.all([t.page.waitForURL((u) => u.searchParams.get("q") === first), t.page.getByRole("button", { name: "Apply" }).click()]);
      assert.equal((await t.page.locator("a.player-name").first().textContent())!.trim(), first);
      await t.page.goto(`${base}/players?level=aa&role=pitchers`);
      const boxes = t.page.locator("input.compare-pick");
      const ids = [await boxes.nth(0).getAttribute("value"), await boxes.nth(1).getAttribute("value")];
      await boxes.nth(0).check();
      await boxes.nth(1).check();
      await Promise.all([t.page.waitForURL((u) => u.pathname === "/compare"), t.page.getByRole("button", { name: "Compare selected" }).click()]);
      const u = new URL(t.page.url());
      assert.deepEqual([u.searchParams.get("level"), u.searchParams.get("role"), u.searchParams.getAll("ids")], ["aa", "pitchers", ids]);
      assert.equal(await t.page.locator("table.compare-table thead th.compare-player").count(), 2);
    } finally {
      await t.ctx.close();
    }
  });
});

describe("organization pages", () => {
  test("directory Org link → organization page (one RSC request) → affiliate player → profile; /orgs lists it", async () => {
    const t = await open();
    try {
      await t.page.goto(`${base}/players?level=aa`, { waitUntil: "networkidle" });
      const orgLink = t.page.locator("table.data-table tbody a[href^='/orgs/']").first();
      const href = (await orgLink.getAttribute("href"))!;
      const abbr = (await orgLink.textContent())!.trim();
      t.reset();
      await clickTo(t, orgLink, pathIs(href));
      assert.equal(rscRequests(t).length, 1, seen(t).join(", "));
      assert.match((await t.page.locator("main .eyebrow").first().textContent()) ?? "", new RegExp(`Organization · ${abbr}`));
      assert.ok(await t.page.locator("main h2#level-aa").isVisible(), "Double-A section");
      const sections = await t.page.locator("main section.org-affiliate").count();
      assert.ok(sections >= 1, "at least one affiliate");
      const player = t.page.locator("section.org-affiliate a.player-name").first();
      const name = (await player.textContent())!.trim();
      await clickTo(t, player, (u) => u.pathname.startsWith("/players/") && u.searchParams.get("level") !== null);
      assert.match((await t.page.locator("main h1").first().textContent()) ?? "", new RegExp(name));
      await t.page.goto(`${base}/orgs`, { waitUntil: "networkidle" });
      assert.ok((await t.page.locator(`main a[href='${href}']`).count()) === 1, "/orgs links the organization");
      assert.deepEqual(t.errors, []);
    } finally {
      await t.ctx.close();
    }
  });

  test("unknown organizations answer HTTP 404; pages render without JavaScript", async () => {
    const t = await open({ javaScriptEnabled: false });
    try {
      for (const slug of ["zzz-not-an-org", "00000000-0000-4000-8000-000000000000"]) {
        const r = await t.page.goto(`${base}/orgs/${slug}`);
        assert.equal(r?.status(), 404, slug);
      }
      const r = await t.page.goto(`${base}/orgs`);
      assert.equal(r?.status(), 200);
      const href = (await t.page.locator("main table a[href^='/orgs/']").first().getAttribute("href"))!;
      const page = await t.page.goto(`${base}${href}`);
      assert.equal(page?.status(), 200, href);
      assert.doesNotMatch(await t.page.content(), /<div hidden="?"? id="S:/);
      assert.ok(await t.page.locator("section.org-affiliate table.data-table tbody tr").first().isVisible());
    } finally {
      await t.ctx.close();
    }
  });
});

describe("header typeahead (T-205)", () => {
  test("keyboard: type → one index request, none per keystroke → ArrowDown + Enter opens the profile", async () => {
    const t = await open();
    try {
      await t.page.goto(`${base}/players?level=aa`, { waitUntil: "networkidle" });
      const name = (await t.page.locator("a.player-name").first().textContent())!.trim();
      const input = t.page.getByRole("combobox", { name: "Search players, teams or organizations" });
      t.reset();
      await input.focus();
      await t.page.waitForLoadState("networkidle");
      await input.pressSequentially(name.slice(0, 6), { delay: 30 });
      const list = t.page.getByRole("listbox", { name: "Player suggestions" });
      await list.waitFor();
      const index = t.requests.filter((r) => r.path === "/search/names");
      assert.deepEqual(index.map((r) => r.search), ["?level=aa"], seen(t).join(", "));
      assert.equal(t.requests.length, 1, `only the index: ${seen(t).join(", ")}`);
      assert.equal(await input.getAttribute("aria-expanded"), "true");
      const options = list.getByRole("option");
      assert.ok((await options.count()) >= 1);
      assert.ok(((await options.first().textContent()) ?? "").toLowerCase().includes(name.slice(0, 6).toLowerCase()), "first suggestion matches the typed text");
      await input.press("ArrowDown");
      const activeId = await input.getAttribute("aria-activedescendant");
      assert.ok(activeId, "the first option is active");
      assert.equal(await t.page.locator(`[id="${activeId}"]`).getAttribute("aria-selected"), "true");
      const picked = (await t.page.locator(`[id="${activeId}"] .typeahead-name`).textContent())!.trim();
      await input.press("Enter");
      await t.page.waitForURL((u) => u.pathname.startsWith("/players/") && u.searchParams.get("level") === "aa");
      await t.page.waitForLoadState("networkidle");
      assert.match((await t.page.locator("main h1").first().textContent()) ?? "", new RegExp(picked));
      // Escape closes the list; Enter with nothing highlighted still submits the plain search.
      await input.fill("zz");
      await input.press("Escape");
      assert.equal(await input.getAttribute("aria-expanded"), "false");
      await input.fill(name.slice(0, 4));
      await input.press("Escape");
      await input.press("Enter");
      await t.page.waitForURL((u) => u.pathname === "/players" && u.searchParams.get("q") === name.slice(0, 4));
      assert.deepEqual(t.errors, []);
    } finally {
      await t.ctx.close();
    }
  });

  test("the index is CDN-cacheable JSON; a stale or unknown key falls back to the directory search", async () => {
    const r = await fetch(`${base}/search/names?level=aa`, { headers: { "x-vercel-forwarded-for": `198.51.100.${ip++ % 250}` } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("vercel-cdn-cache-control"), CDN_CACHE_VALUE);
    const body = await r.text();
    const index = JSON.parse(body);
    assert.equal(index.v, 1);
    assert.equal(index.level, "aa");
    assert.ok(index.players.length > 0);
    assert.ok(body.length < 50_000, `${body.length} bytes`);
    const bad = await fetch(`${base}/search/names?level=nope`, { headers: { "x-vercel-forwarded-for": `198.51.100.${ip++ % 250}` } });
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get("vercel-cdn-cache-control"), null);
    const go = (q: string) => fetch(`${base}/search/player?${q}`, { redirect: "manual", headers: { "x-vercel-forwarded-for": `198.51.100.${ip++ % 250}` } });
    const [key, name] = index.players[0];
    const hit = await go(new URLSearchParams({ level: "aa", id: key, q: name }).toString());
    assert.equal(hit.status, 307);
    assert.match(hit.headers.get("location") ?? "", /^\/players\/[0-9a-f-]{36}\?level=aa$/);
    const miss = await go(new URLSearchParams({ level: "aa", id: "ffffffffffff", q: name }).toString());
    assert.equal(miss.status, 307);
    assert.equal(miss.headers.get("location"), `/players?${new URLSearchParams({ level: "aa", q: name })}`);
    const junk = await go("level=nope&id=x");
    assert.equal(junk.headers.get("location"), "/players");
  });
});

describe("watchlist (per browser)", () => {
  test("star on a directory row → /watchlist lists the player → unstar → empty; profile star persists", async () => {
    const t = await open();
    try {
      await t.page.goto(`${base}/players?level=aa`, { waitUntil: "networkidle" });
      const link = t.page.locator("a.player-name").first();
      const name = (await link.textContent())!.trim();
      const id = new URL((await link.getAttribute("href"))!, base).pathname.split("/").pop()!;
      // Server HTML is neutral; the stored state appears after hydration.
      const star = t.page.getByRole("button", { name: `Add ${name} to watchlist` });
      await t.page.waitForSelector('button.watch-star[data-state="off"]');
      assert.equal(await star.getAttribute("aria-pressed"), "false");
      t.reset();
      await star.click();
      const starred = t.page.getByRole("button", { name: `Remove ${name} from watchlist` });
      assert.equal(await starred.getAttribute("aria-pressed"), "true");
      await settle(t.page);
      assert.deepEqual(seen(t), [], "starring is local: no request");
      assert.deepEqual(await t.page.evaluate(() => [document.cookie, JSON.parse(localStorage.getItem("pt.watchlist.v1") ?? "[]")]), ["", [id]]);

      // The header tab opens /watchlist; the client puts the stored ids into the URL.
      await clickTo(t, tab(t.page, "Watchlist"), (u) => u.pathname === "/watchlist" && u.searchParams.get("ids") === id);
      const main = () => t.page.locator("main").textContent();
      const rows = () => t.page.locator("main table.data-table tbody a.player-name").allTextContents();
      assert.deepEqual((await rows()).map((n) => n.trim()), [name]);
      assert.match((await main()) ?? "", /Double-A|AA/);

      // Unstar from the watchlist itself: the URL and the table follow.
      await t.page.getByRole("button", { name: `Remove ${name} from watchlist` }).click();
      await t.page.waitForURL((u) => u.pathname === "/watchlist" && !u.searchParams.has("ids"));
      await t.page.waitForLoadState("networkidle");
      await t.page.getByText("No players on your watchlist yet.").waitFor();
      assert.deepEqual(await rows(), []);
      assert.equal(await t.page.evaluate(() => localStorage.getItem("pt.watchlist.v1")), null);

      // Profile star (labelled) persists across a reload of the cached page.
      await t.page.goto(`${base}/players/${id}`, { waitUntil: "networkidle" });
      await t.page.getByRole("button", { name: `Add ${name} to watchlist` }).click();
      await t.page.reload({ waitUntil: "networkidle" });
      await t.page.waitForSelector('button.watch-star.labelled[data-state="on"]');
      assert.equal(await t.page.getByRole("button", { name: `Remove ${name} from watchlist` }).getAttribute("aria-pressed"), "true");
      assert.deepEqual([...t.errors], [], "no hydration or runtime errors");
    } finally {
      await t.ctx.close();
    }
  });

  test("storage blocked: stars are disabled with an explanation, /watchlist explains, nothing crashes", async () => {
    const t = await open();
    try {
      await t.ctx.addInitScript(() => {
        Object.defineProperty(window, "localStorage", {
          configurable: true,
          get() {
            throw new DOMException("The operation is insecure.", "SecurityError");
          },
        });
      });
      await t.page.goto(`${base}/players?level=aa`, { waitUntil: "networkidle" });
      await t.page.waitForSelector('button.watch-star[data-state="unavailable"]');
      const star = t.page.locator("button.watch-star").first();
      assert.equal(await star.getAttribute("aria-disabled"), "true");
      assert.match((await star.textContent()) ?? "", /Watchlist unavailable for .+: this browser is blocking site storage/);
      // aria-disabled (not disabled): it stays focusable and says why when activated.
      await star.focus();
      await t.page.keyboard.press("Enter");
      assert.match((await t.page.locator(".watch-message").first().textContent()) ?? "", /blocking site storage/);

      const r = await t.page.goto(`${base}/watchlist`, { waitUntil: "networkidle" });
      assert.equal(r?.status(), 200);
      await t.page.getByText("This browser is blocking site storage", { exact: false }).waitFor();
      assert.equal(new URL(t.page.url()).search, "", "no redirect loop");
      assert.deepEqual([...t.errors], []);
    } finally {
      await t.ctx.close();
    }
  });

  test("bad or unknown ids are a notice on a 200 page, never a 404", async () => {
    const r = await fetch(`${base}/watchlist?ids=not-a-uuid,00000000-0000-4000-8000-00000000dead`, { headers: { "x-vercel-forwarded-for": "198.51.100.251" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("set-cookie"), null, "no cookies");
    const html = await r.text();
    assert.match(html, /1 invalid player id was ignored\./);
    assert.match(html, /is not in the loaded 2026 data/);
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

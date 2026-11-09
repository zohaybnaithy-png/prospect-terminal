/**
 * Automated accessibility scan (axe-core, WCAG 2.0/2.1/2.2 A + AA) of a RUNNING Prospect Terminal.
 * Read-only: it only loads pages in a headless browser, so it never touches a database itself.
 *
 *   npm run build && DATABASE_URL=<disposable dev db> npm start      # or any running instance
 *   A11Y_BASE_URL=http://localhost:3000 npm run -s a11y:scan > ~/pt-runs/a11y.json
 *
 * Options (env):
 *   A11Y_BASE_URL     site to scan (default http://localhost:3000)
 *   A11Y_PATHS        comma-separated extra paths to scan in addition to the defaults
 *   A11Y_BROWSER      Chromium executable (default: Playwright's installed Chromium)
 *   A11Y_STRICT=1     exit 1 when any violation is found (for CI)
 *   A11Y_MAX_TARGETS  element selectors listed per violation and page (default 10)
 *
 * Each page is scanned at a desktop (1366 px) and a phone (390 px) width, as loaded and again with
 * every <details> disclosure and the phone filter panel open. Player profiles are
 * discovered from the directory, so the scan works on any data set. Progress goes to stderr; stdout
 * carries only the final JSON report.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium, type Page } from "playwright-core";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
const VIEWPORTS = [
  { name: "desktop", width: 1366, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

const MAX_TARGETS = Number(process.env.A11Y_MAX_TARGETS ?? 10);
const base = (process.env.A11Y_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const log = (message: string) => process.stderr.write(`[a11y] ${message}\n`);

interface AxeNode {
  target: string[];
  failureSummary?: string;
}
interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: AxeNode[];
}

async function profilePaths(page: Page): Promise<string[]> {
  const found: string[] = [];
  for (const role of ["hitter", "pitcher"]) {
    await page.goto(`${base}/players${role === "pitcher" ? "?role=pitchers" : ""}`, { waitUntil: "networkidle" });
    const href = await page
      .locator("a.player-name[href^='/players/']")
      .first()
      .getAttribute("href")
      .catch(() => null);
    if (href) found.push(href);
  }
  return found;
}

async function scan(page: Page) {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(async (tags) => {
    const axe = (window as unknown as {
      axe: { run: (c: Document, o: object) => Promise<{ violations: AxeViolation[]; incomplete: AxeViolation[] }> };
    }).axe;
    const r = await axe.run(document, {
      runOnly: { type: "tag", values: tags },
      resultTypes: ["violations", "incomplete"],
    });
    return { violations: r.violations, incomplete: r.incomplete };
  }, TAGS);
}

/** Second state per page: every disclosure open and the phone filter panel shown. */
async function expand(page: Page) {
  const toggle = page.locator(".filters-toggle[aria-expanded='false']");
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
  await page.waitForTimeout(150);
}

type PageResult = {
  path: string;
  viewport: string;
  state: "initial" | "expanded";
  horizontalOverflowPx?: number;
  violations: { id: string; impact: string | null; help: string; count: number; targets: string[] }[];
  /** axe could not decide (e.g. text over an image or gradient); needs a manual look. */
  needsReview: Record<string, number>;
};

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.A11Y_BROWSER ? { executablePath: process.env.A11Y_BROWSER } : {}),
  });
  try {
    const discover = await browser.newPage();
    const paths = [
      "/",
      "/players",
      "/players?role=pitchers",
      "/players?level=afl",
      "/trends",
      "/data",
      ...(await profilePaths(discover)),
      "/this-page-does-not-exist",
      ...(process.env.A11Y_PATHS?.split(",").map((p) => p.trim()).filter(Boolean) ?? []),
    ];
    await discover.close();

    const pages: PageResult[] = [];
    const totals: Record<string, { impact: string | null; help: string; count: number }> = {};
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      for (const path of paths) {
        await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
        for (const state of ["initial", "expanded"] as const) {
          if (state === "expanded") await expand(page);
          const { violations, incomplete } = await scan(page);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          for (const v of violations) {
            totals[v.id] ??= { impact: v.impact, help: v.help, count: 0 };
            totals[v.id].count += v.nodes.length;
          }
          pages.push({
            path,
            viewport: viewport.name,
            state,
            ...(overflow > 0 ? { horizontalOverflowPx: overflow } : {}),
            violations: violations.map((v) => ({
              id: v.id,
              impact: v.impact,
              help: v.help,
              count: v.nodes.length,
              targets: v.nodes.slice(0, MAX_TARGETS).map((n) => n.target.join(" ")),
            })),
            needsReview: Object.fromEntries(incomplete.map((v) => [v.id, v.nodes.length])),
          });
          const n = violations.reduce((s, v) => s + v.nodes.length, 0);
          log(
            `${viewport.name} ${path} (${state}): ${n} violation node(s)` +
              (overflow > 0 ? `, page overflows by ${overflow}px` : ""),
          );
        }
      }
      await context.close();
    }
    const total = Object.values(totals).reduce((s, t) => s + t.count, 0);
    console.log(JSON.stringify({ base, tags: TAGS, totalViolationNodes: total, byRule: totals, pages }, null, 2));
    if (process.env.A11Y_STRICT === "1" && total > 0) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  log(`scan failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

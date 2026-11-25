/**
 * Read-only verification of a protected Vercel Preview deployment (docs/AUTONOMOUS-WORKFLOW.md).
 *
 *   npm run verify:preview -- --pr 22
 *   npm run verify:preview -- --sha <commit> | --deployment dpl_… [--polls 10] [--skip-browser] [--wait-minutes 15]
 *
 * Steps: resolve the newest READY Preview for the PR/commit (refuses Production) → confirm Deployment
 * Protection still blocks anonymous requests → build log facts (guard passed, snapshot exported and
 * verified, views built) → /health with a bounded cold-start allowance → page checks over HTTP →
 * browser smoke test (Playwright) → runtime logs for the test window (startup snapshot id must match
 * the build's) → one JSON report on stdout, progress on stderr. Exit 0 only when every check passes.
 *
 * Needs: a logged-in Vercel CLI and a linked repo (`.vercel/project.json`), the project's existing
 * "Protection Bypass for Automation" secret (read in-process from the Vercel API, never printed, sent
 * only to the deployment's own host), and for --pr: `gh` or the public GitHub API.
 * It never deploys, changes settings or environment variables, creates secrets or touches Production.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BYPASS_HEADER,
  LEVEL_LABELS,
  classifyRuntimeLogs,
  createHealthEvaluator,
  DEFAULT_HEALTH_POLICY,
  isBenignConsoleError,
  isPreviewHost,
  isProtectionResponse,
  mayReceiveBypass,
  parseBuildLog,
  sameSnapshot,
  type RuntimeLogRecord,
} from "./preview-verify-support";

type Check = { name: string; ok: boolean; detail?: string; warning?: boolean };
const checks: Check[] = [];
const log = (line: string) => process.stderr.write(`[verify-preview] ${line}\n`);
const check = (name: string, ok: boolean, detail?: string, warning = false) => {
  checks.push({ name, ok, detail, warning });
  log(`${ok ? "PASS" : warning ? "WARN" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

/** Runs a CLI and returns stdout. stderr is discarded so nothing sensitive can be echoed. */
function run(cmd: string, args: string[], timeoutMs = 120_000): string {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
}
const vercelApi = <T>(endpoint: string): T => JSON.parse(run("vercel", ["api", endpoint])) as T;

/** `vercel inspect --logs` prints the build log on stderr; build logs carry no secret values. */
function buildLog(deploymentId: string, scope: string): string {
  const r = spawnSync("vercel", ["inspect", deploymentId, "--logs", "--scope", scope], { encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
  return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
}

function linkedProject(): { projectId: string; orgId: string } {
  try {
    const j = JSON.parse(readFileSync(path.join(process.cwd(), ".vercel", "project.json"), "utf8"));
    if (typeof j.projectId === "string" && typeof j.orgId === "string") return j;
  } catch {}
  throw new Error("repo is not linked to Vercel: run `vercel link --yes --project prospect-terminal --scope zo-s` (then delete the .env.local it writes and revert its .gitignore line)");
}

async function prHeadSha(pr: string): Promise<{ sha: string; branch: string }> {
  try {
    const j = JSON.parse(run("gh", ["pr", "view", pr, "--json", "headRefOid,headRefName"]));
    return { sha: j.headRefOid, branch: j.headRefName };
  } catch {
    const remote = run("git", ["remote", "get-url", "origin"]).trim();
    const slug = remote.match(/github\.com[:/](.+?)(\.git)?$/)?.[1];
    if (!slug) throw new Error("cannot resolve the GitHub repository from origin");
    const r = await fetch(`https://api.github.com/repos/${slug}/pulls/${encodeURIComponent(pr)}`, { headers: { accept: "application/vnd.github+json" } });
    if (!r.ok) throw new Error(`GitHub API: PR ${pr} lookup failed (HTTP ${r.status})`);
    const j = (await r.json()) as { head: { sha: string; ref: string } };
    return { sha: j.head.sha, branch: j.head.ref };
  }
}

type Deployment = { id: string; url: string; readyState: string; target: string | null; meta?: Record<string, string>; createdAt: number };

async function resolveDeployment(project: { projectId: string; orgId: string }): Promise<Deployment> {
  const q = `teamId=${project.orgId}`;
  const explicit = arg("deployment");
  if (explicit) return vercelApi<Deployment>(`/v13/deployments/${encodeURIComponent(explicit)}?${q}`);
  let sha = arg("sha");
  const pr = arg("pr");
  if (!sha && pr) sha = (await prHeadSha(pr)).sha;
  if (!sha) throw new Error("pass --pr <n>, --sha <commit> or --deployment <dpl_id>");
  const deadline = Date.now() + Number(arg("wait-minutes") ?? 15) * 60_000;
  for (;;) {
    const list = vercelApi<{ deployments: { uid: string; state?: string; readyState?: string; created: number }[] }>(
      `/v6/deployments?projectId=${project.projectId}&${q}&sha=${sha}&limit=20`,
    ).deployments.sort((a, b) => b.created - a.created);
    const newest = list[0];
    const state = newest?.state ?? newest?.readyState;
    if (newest && state === "READY") return vercelApi<Deployment>(`/v13/deployments/${newest.uid}?${q}`);
    if (newest && (state === "ERROR" || state === "CANCELED")) {
      check("deployment ready", false, `newest deployment ${newest.uid} for ${sha.slice(0, 7)} is ${state}; read its log: vercel inspect ${newest.uid} --logs`);
      return vercelApi<Deployment>(`/v13/deployments/${newest.uid}?${q}`);
    }
    if (Date.now() > deadline) throw new Error(`no READY deployment for ${sha.slice(0, 7)} (newest: ${newest ? `${newest.uid} ${state}` : "none"})`);
    log(`waiting for a deployment of ${sha.slice(0, 7)} (newest: ${newest ? state : "none yet"})`);
    await sleep(20_000);
  }
}

function bypassSecret(project: { projectId: string; orgId: string }): string {
  const p = vercelApi<{ protectionBypass?: Record<string, { scope?: string }> }>(`/v9/projects/${project.projectId}?teamId=${project.orgId}`);
  const secret = Object.entries(p.protectionBypass ?? {}).find(([, v]) => v.scope === "automation-bypass")?.[0];
  if (!secret)
    throw new Error("the project has no Protection Bypass for Automation secret. Creating one is a human-approved step (docs/AUTONOMOUS-WORKFLOW.md)");
  return secret;
}

async function main() {
  const started = new Date();
  const project = linkedProject();
  const dep = await resolveDeployment(project);
  const host = dep.url.replace(/^https?:\/\//, "");
  const base = `https://${host}`;
  log(`deployment ${dep.id} ${base} (${dep.meta?.githubCommitRef ?? "?"} @ ${dep.meta?.githubCommitSha?.slice(0, 7) ?? "?"})`);

  // Hard stops: only READY Preview deployments on *.vercel.app are ever exercised.
  if (dep.target === "production") throw new Error("refusing to verify a Production deployment");
  if (!isPreviewHost(host)) throw new Error(`unexpected deployment host ${host}`);
  check("deployment is a Preview", dep.target !== "production", `target ${dep.target ?? "preview"}`);
  check("deployment ready", dep.readyState === "READY", dep.readyState);
  if (dep.readyState !== "READY") return finish(dep, base, started);

  // 1. Deployment Protection must still block anonymous requests (no bypass header here).
  const anon = await fetch(`${base}/health`, { redirect: "manual" });
  check("Deployment Protection enabled", isProtectionResponse(anon.status, anon.headers.get("location"), await anon.text()), `anonymous /health → ${anon.status}`);

  // 2. Build log facts.
  // Vercel can report READY a few seconds before the stored build log has its final lines, so a log
  // read right at READY may lack "Deployment completed". Bounded retry; a genuinely incomplete log still fails.
  let build = parseBuildLog(buildLog(dep.id, project.orgId));
  for (let attempt = 1; attempt < 4 && !(build.buildCompleted && build.snapshotId); attempt++) {
    log(`build log incomplete (attempt ${attempt}); re-reading in 10 s`);
    await sleep(10_000);
    build = parseBuildLog(buildLog(dep.id, project.orgId));
  }
  check("build guard passed", !build.guardRefused);
  check("build completed", build.buildCompleted);
  check("snapshot exported and verified", !!build.snapshotId && build.verifiedLevels === build.exportedLevels.length && build.exportedLevels.length > 0,
    `snapshot ${build.snapshotId?.slice(0, 12) ?? "none"}, ${build.verifiedLevels ?? 0}/${build.exportedLevels.length} levels verified`);
  check("precomputed views built", build.viewsDone && build.viewsLevels.length === build.exportedLevels.length, `${build.viewsLevels.length} levels`);
  for (const l of build.exportedLevels) check(`snapshot level ${l.level} non-empty`, l.players > 0 && l.games > 0, `${l.players} players, ${l.games} games`);

  const secret = bypassSecret(project);
  /** fetch that adds the bypass header only for the deployment's own host and never follows redirects. */
  const pfetch = (url: string) => {
    if (!mayReceiveBypass(url, host)) throw new Error(`refusing to send the bypass header to ${new URL(url).host}`);
    return fetch(url, { redirect: "manual", headers: { [BYPASS_HEADER]: secret } });
  };

  // 3. /health: bounded warm-up for the first cold start, then N ready answers.
  const polls = Number(arg("polls") ?? DEFAULT_HEALTH_POLICY.polls);
  const evaluator = createHealthEvaluator({ ...DEFAULT_HEALTH_POLICY, polls });
  for (;;) {
    const r = await pfetch(`${base}/health`);
    const more = evaluator.add({ status: r.status, body: await r.text() });
    if (!more) break;
    await sleep(r.status === 503 ? 3000 : 1000);
  }
  const hv = evaluator.verdict();
  check("health ready (snapshot views on, 0 fallbacks)", hv.ok,
    `${hv.readyCount} ready, ${hv.coldStarts} cold-start answers, warm-up ${hv.warmupAttemptsUsed} attempt(s)${hv.failures.length ? `; ${hv.failures.join("; ")}` : ""}`);

  // 4. Page checks over HTTP.
  const levels = build.exportedLevels.map((l) => l.level);
  if (levels.length === 0) {
    check("levels known from the build log", false, "no level lines found; page checks cannot run");
    return finish(dep, base, started, build.snapshotId);
  }
  const pages: { path: string; expect: number }[] = [
    { path: "/", expect: 200 },
    ...levels.map((l) => ({ path: `/players?level=${l}`, expect: 200 })),
    { path: "/this-page-does-not-exist", expect: 404 },
  ];
  const levelIds: Record<string, Set<string>> = {};
  for (const p of pages) {
    const r = await pfetch(base + p.path);
    const html = await r.text();
    const ids = new Set([...html.matchAll(/href="\/players\/([0-9a-f-]{36})/g)].map((m) => m[1]));
    const appError = /Application error|Internal Server Error/i.test(html);
    const level = p.path.match(/level=([a-z0-9-]+)/)?.[1];
    if (level) levelIds[level] = ids;
    const label = level ? LEVEL_LABELS[level] : null;
    const labelOk = !label || html.split(label).length - 1 >= 10;
    check(`GET ${p.path}`, r.status === p.expect && !appError && (p.expect !== 200 || p.path === "/" || (ids.size > 0 && labelOk)),
      `${r.status}${p.expect === 200 ? `, ${ids.size} player links` : ""}${label ? `, ${label} ${labelOk ? "shown" : "missing"}` : ""}`);
  }
  const lv = Object.keys(levelIds);
  for (let i = 0; i < lv.length; i++)
    for (let j = i + 1; j < lv.length; j++) {
      const a = levelIds[lv[i]], b = levelIds[lv[j]];
      const overlap = [...a].filter((x) => b.has(x)).length;
      if (lv[i] !== "afl" && lv[j] !== "afl" && overlap > Math.min(a.size, b.size) / 2)
        check(`levels ${lv[i]}/${lv[j]} serve different players`, false, `${overlap} shared of ${Math.min(a.size, b.size)}`);
    }

  // 5. Browser smoke test.
  if (!flag("skip-browser")) await browserSmoke(base, host, secret, levels);

  // 6. Runtime logs for the test window (Hobby keeps ~30–60 min, so read them right away).
  await sleep(5000);
  let rt: ReturnType<typeof classifyRuntimeLogs> | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = run("vercel", ["logs", "-p", project.projectId, "--scope", project.orgId, "--deployment", dep.id, "--since", started.toISOString(), "-n", "2000", "--json"]);
      const recs = out.trim().split("\n").flatMap((l) => {
        try {
          const j = JSON.parse(l);
          return j.type === "log" ? [j.data as RuntimeLogRecord] : [];
        } catch {
          return [];
        }
      });
      rt = classifyRuntimeLogs(recs);
      if (rt.startups.length) break;
    } catch {
      rt = null;
    }
    await sleep(10_000);
  }
  if (!rt) check("runtime logs readable", false, "vercel logs failed");
  else {
    check("runtime logs: no errors", rt.problems.length === 0, `${rt.records} records${rt.problems.length ? `; ${rt.problems.slice(0, 5).join(" | ")}` : ""}`);
    if (rt.startups.length)
      check("runtime snapshot matches build", rt.startups.every((s) => sameSnapshot(build.snapshotId, s.snapshot) && s.levels === levels.length),
        `${rt.startups.length} instance start(s), snapshot ${rt.startups[0].snapshot}, ${rt.startups[0].levels} levels`);
    else check("runtime snapshot matches build", true, "no instance started during the test (warm instances only); health views=on is the evidence", true);
  }

  // 7. Protection still on after the run.
  const anon2 = await fetch(`${base}/`, { redirect: "manual" });
  check("Deployment Protection still enabled", isProtectionResponse(anon2.status, anon2.headers.get("location"), await anon2.text()), `anonymous / → ${anon2.status}`);

  return finish(dep, base, started, build.snapshotId);
}

async function browserSmoke(base: string, host: string, secret: string, levels: string[]) {
  let chromium: typeof import("playwright-core").chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    check("browser smoke test", false, "playwright-core not installed (npm ci)");
    return;
  }
  let browser;
  try {
    browser = await chromium.launch(process.env.PREVIEW_VERIFY_BROWSER ? { executablePath: process.env.PREVIEW_VERIFY_BROWSER } : {});
  } catch {
    check("browser smoke test", false, "no Chromium: run `npx playwright-core install chromium-headless-shell`");
    return;
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const foreignOrigins = new Set<string>();
  // The bypass header is attached per request, only for the deployment's host; never via extraHTTPHeaders.
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (mayReceiveBypass(url, host)) return route.continue({ headers: { ...route.request().headers(), [BYPASS_HEADER]: secret } });
    foreignOrigins.add(new URL(url).origin);
    return route.continue();
  });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failed: string[] = [];
  page.on("console", (m) => m.type() === "error" && !isBenignConsoleError(m.text()) && consoleErrors.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (u.host === host && r.status() >= 400 && !u.pathname.startsWith("/this-page-does-not-exist")) failed.push(`${r.status()} ${u.pathname}${u.search}`);
  });
  try {
    for (const p of ["/", ...levels.map((l) => `/players?level=${l}`)]) {
      const r = await page.goto(base + p, { waitUntil: "networkidle", timeout: 60_000 });
      const rows = await page.locator('main a[href^="/players/"]').count();
      check(`browser ${p}`, r?.status() === 200 && (p === "/" || rows > 0), `${r?.status()}, ${rows} player links`);
    }
    const lvl = levels.includes("high-a") ? "high-a" : levels[0];
    await page.goto(`${base}/players?level=${lvl}`, { waitUntil: "networkidle" });
    const link = page.locator('main a[href^="/players/"]').first();
    const name = (await link.innerText()).trim().split("\n")[0];
    const href = (await link.getAttribute("href")) ?? "";
    await link.click();
    await page.waitForURL((u) => u.pathname === href.split("?")[0], { timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    const text = await page.locator("main").innerText();
    const label = LEVEL_LABELS[lvl];
    check(`browser ${lvl} profile via client navigation`, text.includes(name) && (!label || text.includes(label)), `${name}`);
  } catch (e) {
    check("browser smoke test", false, String(e).slice(0, 200));
  } finally {
    await browser.close();
  }
  check("browser: no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | ") || "0");
  check("browser: no console errors (Vercel toolbar CSP excluded)", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | ") || "0");
  check("browser: no failed same-origin requests", failed.length === 0, failed.slice(0, 5).join(", ") || "0");
  log(`third-party origins contacted without the bypass header: ${[...foreignOrigins].join(", ") || "none"}`);
}

function finish(dep: Deployment, base: string, started: Date, snapshotId?: string | null) {
  const failedChecks = checks.filter((c) => !c.ok && !c.warning);
  const report = {
    ok: failedChecks.length === 0,
    deployment: { id: dep.id, url: base, branch: dep.meta?.githubCommitRef, sha: dep.meta?.githubCommitSha, pr: dep.meta?.githubPrId },
    snapshotId: snapshotId ?? null,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    passed: checks.filter((c) => c.ok && !c.warning).length,
    warnings: checks.filter((c) => c.warning).map((c) => `${c.name}: ${c.detail ?? ""}`),
    failed: failedChecks.map((c) => `${c.name}: ${c.detail ?? ""}`),
    checks,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((e) => {
  // Messages are ours or CLI exit codes; command output (which could carry secrets) is never included.
  log(`ERROR ${e instanceof Error ? e.message.split("\n")[0].slice(0, 300) : "unknown"}`);
  process.stdout.write(JSON.stringify({ ok: false, error: e instanceof Error ? e.message.split("\n")[0].slice(0, 300) : "unknown", checks }, null, 2) + "\n");
  process.exitCode = 1;
});

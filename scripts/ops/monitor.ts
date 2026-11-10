/**
 * Local monitor (docs/OBSERVABILITY.md): one run checks the things that need a person, on the
 * server itself, with no external service. Meant for a systemd timer every 5 minutes
 * (deploy/prospect-terminal-monitor.{service,timer}, shipped DISABLED).
 *
 *   npm run -s monitor                    # JSON report on stdout; exit 0 ok, 1 alert, 2 could not run
 *
 * Checks (each can be skipped when its input is not available on this host):
 *   app        /health answers within 5 s (down or unreachable → alert)
 *   health     ready; traffic protection not misconfigured; no level whose database refresh is failing
 *   memory     resident memory below PT_MONITOR_RSS_MB_MAX (default 2560 of the 3 GB MemoryMax)
 *   http-5xx   Caddy access log: 5xx share over the last PT_MONITOR_WINDOW_MINUTES (default 10);
 *              alert at ≥ 5 errors and ≥ 2% of requests
 *   refresh    last data-refresh job (last-job.json): failed/error/aborted/locked-stale → alert;
 *              no job for 26 h while a source is in season → alert (timer stopped)
 *   freshness  with DATABASE_URL (the read-only web role is enough): stale data → alert
 *
 * Env: PT_MONITOR_HEALTH_URL (default http://127.0.0.1:3000/health), PT_MONITOR_ACCESS_LOG
 * (default /var/log/caddy/access.log), PT_MONITOR_REFRESH_STATE (default
 * /var/lib/prospect-terminal-ingest/refresh/last-job.json), PT_MONITOR_RSS_MB_MAX,
 * PT_MONITOR_WINDOW_MINUTES, PT_MONITOR_PING_URL (optional https dead-man's switch: pinged on every
 * run, `<url>/fail` on alert; if pings stop, the machine or the monitor is down).
 * Never prints credentials; the access log is read but never echoed (it contains client addresses).
 */
import { closeSync, openSync, readSync, statSync, readFileSync } from "node:fs";
import { Pool } from "pg";
import { DEFAULT_REFRESH } from "../../src/ingestion/refresh/job";
import { assessFreshness, readFreshnessFacts } from "../../src/ingestion/refresh/freshness";
import { seasonWindowsFromEnv, shouldRefresh, isoDate, type RefreshSource, type SeasonWindow } from "../../src/ingestion/refresh/schedule";

export type CheckStatus = "ok" | "alert" | "skipped";
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** /health response → health and memory checks. */
export function evaluateHealth(httpStatus: number, body: unknown, rssMbMax: number): Check[] {
  const b = (body ?? {}) as {
    status?: string;
    refreshFailing?: string[];
    traffic?: { status?: string; reason?: string };
    process?: { rssMB?: number; heapUsedMB?: number; heapLimitMB?: number };
  };
  const problems: string[] = [];
  if (httpStatus !== 200 || b.status !== "ready") problems.push(`status ${httpStatus} ${b.status ?? "?"}`);
  if (b.traffic?.status === "misconfigured") problems.push(`traffic protection misconfigured (${b.traffic.reason ?? "?"})`);
  if (b.refreshFailing?.length) problems.push(`database refresh failing for ${b.refreshFailing.join(", ")} (serving older data)`);
  const checks: Check[] = [
    { name: "health", status: problems.length ? "alert" : "ok", detail: problems.length ? problems.join("; ") : `ready; traffic ${b.traffic?.status ?? "?"}` },
  ];
  const rss = b.process?.rssMB;
  checks.push(
    rss === undefined
      ? { name: "memory", status: "skipped", detail: "no process figures in /health" }
      : {
          name: "memory",
          status: rss > rssMbMax ? "alert" : "ok",
          detail: `rss ${rss} MB (alert above ${rssMbMax}); heap ${b.process?.heapUsedMB ?? "?"}/${b.process?.heapLimitMB ?? "?"} MB`,
        },
  );
  return checks;
}

/** Caddy JSON access-log lines → 5xx count and share within the window. Malformed lines are ignored. */
export function analyzeAccessLog(lines: string[], nowMs: number, windowMs: number) {
  let total = 0, errors = 0;
  const byStatus: Record<string, number> = {};
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    let e: { ts?: number; status?: number };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof e.ts !== "number" || typeof e.status !== "number") continue;
    if (nowMs - e.ts * 1000 > windowMs || e.ts * 1000 > nowMs + 60_000) continue;
    total++;
    if (e.status >= 500) {
      errors++;
      byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    }
  }
  return { total, errors, share: total ? errors / total : 0, byStatus };
}

export function evaluate5xx(a: ReturnType<typeof analyzeAccessLog>, windowMinutes: number): Check {
  const alert = a.errors >= 5 && a.share >= 0.02;
  const by = Object.entries(a.byStatus).map(([s, n]) => `${s}×${n}`).join(", ");
  return {
    name: "http-5xx",
    status: alert ? "alert" : "ok",
    detail: `${a.errors} of ${a.total} requests in the last ${windowMinutes} min were 5xx${by ? ` (${by})` : ""}`,
  };
}

/** The refresh job's last-job.json → refresh check. */
export function evaluateRefresh(
  record: { status?: string; finishedAt?: string; error?: string; abortReason?: string } | null,
  now: Date,
  windows: Record<RefreshSource, SeasonWindow>,
): Check {
  const inSeason = (["milb", "afl"] as const).some((s) => shouldRefresh(s, isoDate(now), windows));
  if (!record) return { name: "refresh", status: inSeason ? "alert" : "ok", detail: inSeason ? "no refresh job recorded while a source is in season" : "no job recorded (off-season)" };
  const bad = ["failed", "error", "timed-out", "aborted", "locked-stale"];
  if (record.status && bad.includes(record.status))
    return { name: "refresh", status: "alert", detail: `last job ${record.status}${record.abortReason ? ` (${record.abortReason})` : ""}${record.error ? `: ${record.error}` : ""}` };
  const ageH = record.finishedAt ? (now.getTime() - Date.parse(record.finishedAt)) / 3_600_000 : Infinity;
  if (inSeason && ageH > 26)
    return { name: "refresh", status: "alert", detail: `no refresh job for ${Math.round(ageH)} h while in season (is the timer running?)` };
  return { name: "refresh", status: "ok", detail: `last job ${record.status ?? "?"} ${Number.isFinite(ageH) ? `${Math.round(ageH)} h ago` : ""}`.trim() };
}

export function overall(checks: Check[]): "ok" | "alert" {
  return checks.some((c) => c.status === "alert") ? "alert" : "ok";
}

/** Reads at most the last `maxBytes` of a file as lines (the access log can be 50 MB). */
export function tailLines(path: string, maxBytes = 8 * 1_048_576): string[] {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  if (start > 0) lines.shift(); // first line is partial
  return lines;
}

export async function runMonitor(
  env: Record<string, string | undefined> = process.env,
  deps: { fetch?: typeof fetch; now?: () => Date } = {},
): Promise<{ status: "ok" | "alert"; checks: Check[] }> {
  const fetcher = deps.fetch ?? fetch;
  const now = deps.now?.() ?? new Date();
  const windowMinutes = Number(env.PT_MONITOR_WINDOW_MINUTES ?? 10) || 10;
  const rssMax = Number(env.PT_MONITOR_RSS_MB_MAX ?? 2560) || 2560;
  const checks: Check[] = [];

  // app + health + memory
  const healthUrl = env.PT_MONITOR_HEALTH_URL ?? "http://127.0.0.1:3000/health";
  try {
    const r = await fetcher(healthUrl, { signal: AbortSignal.timeout(5_000) });
    checks.push({ name: "app", status: "ok", detail: `/health answered ${r.status}` });
    checks.push(...evaluateHealth(r.status, await r.json().catch(() => null), rssMax));
  } catch (error) {
    const code = error instanceof Error ? error.name : "error";
    checks.push({ name: "app", status: "alert", detail: `/health did not answer (${code}): the app is down or unreachable` });
  }

  // http-5xx
  const accessLog = env.PT_MONITOR_ACCESS_LOG ?? "/var/log/caddy/access.log";
  try {
    checks.push(evaluate5xx(analyzeAccessLog(tailLines(accessLog), now.getTime(), windowMinutes * 60_000), windowMinutes));
  } catch {
    checks.push({ name: "http-5xx", status: "skipped", detail: `access log not readable at ${accessLog}` });
  }

  // refresh
  const windows = seasonWindowsFromEnv(env);
  const statePath = env.PT_MONITOR_REFRESH_STATE ?? "/var/lib/prospect-terminal-ingest/refresh/last-job.json";
  let record: Parameters<typeof evaluateRefresh>[0] | undefined;
  try {
    record = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") record = null;
  }
  checks.push(
    record === undefined
      ? { name: "refresh", status: "skipped", detail: `refresh state not readable at ${statePath}` }
      : evaluateRefresh(record, now, windows),
  );

  // freshness (optional database read)
  if (env.DATABASE_URL) {
    const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10_000 });
    pool.on("error", () => {});
    try {
      const report = assessFreshness(
        await readFreshnessFacts(pool, { season: now.getUTCFullYear(), now, abandonedAfterMs: DEFAULT_REFRESH.abandonedAfterMs }),
        undefined,
        windows,
      );
      checks.push({ name: "freshness", status: report.verdict === "ok" ? "ok" : "alert", detail: report.reasons.join("; ") || "fresh" });
    } catch (error) {
      checks.push({ name: "freshness", status: "alert", detail: `could not read freshness (${(error as { code?: string }).code ?? (error as Error).name}): database unreachable?` });
    } finally {
      await pool.end().catch(() => {});
    }
  } else checks.push({ name: "freshness", status: "skipped", detail: "DATABASE_URL not set" });

  const status = overall(checks);
  const ping = env.PT_MONITOR_PING_URL;
  if (ping && /^https:\/\//.test(ping)) {
    await fetcher(status === "ok" ? ping : `${ping.replace(/\/$/, "")}/fail`, {
      method: "POST",
      body: JSON.stringify({ status, alerts: checks.filter((c) => c.status === "alert").map((c) => c.name) }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }
  return { status, checks };
}

if (process.argv[1] && /monitor\.ts$/.test(process.argv[1]))
  runMonitor()
    .then((r) => {
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      for (const c of r.checks) if (c.status === "alert") process.stderr.write(`[monitor] ALERT ${c.name}: ${c.detail}\n`);
      process.exitCode = r.status === "ok" ? 0 : 1;
    })
    .catch((error: unknown) => {
      process.stderr.write(`[monitor] could not run: ${error instanceof Error ? error.name : "error"}\n`);
      process.exitCode = 2;
    });

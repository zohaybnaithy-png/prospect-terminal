/**
 * Pure helpers for `scripts/verify-preview.ts` (read-only verification of a protected Vercel Preview).
 * Everything here is side-effect free so it can be unit tested (scripts/preview-verify.test.ts).
 *
 * Lessons from PR #22 encoded here:
 * - A brand-new serverless instance answers `/health` with 503 `{"status":"unavailable","views":
 *   {"status":"pending"}}` until its snapshot is loaded. That is by design; a bounded retry absorbs it.
 * - Warm instances answer 200 `{"status":"ready","views":{"status":"on","fallbacks":0}}` in snapshot mode.
 * - Startup lines such as `[competition-views] precomputed views on (snapshot <id>, 5 levels)` go to
 *   stderr, so Vercel labels them level "error". They are not errors.
 * - Vercel injects a feedback toolbar script (vercel.live) that the site's CSP blocks: a benign console error.
 * - The automation bypass secret must only ever be sent to the deployment's own host.
 */

export const BYPASS_HEADER = "x-vercel-protection-bypass";

/** Hosts a Preview may be served from. Anything else never receives the bypass header. */
export function isPreviewHost(host: string): boolean {
  return /^[a-z0-9-]+\.vercel\.app$/i.test(host);
}

/**
 * The bypass header goes to exactly one origin: the deployment under test (https, same host).
 * Redirect targets, vercel.live, analytics, fonts and every other origin get nothing.
 */
export function mayReceiveBypass(requestUrl: string, deploymentHost: string): boolean {
  let u: URL;
  try {
    u = new URL(requestUrl);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.host.toLowerCase() === deploymentHost.toLowerCase() && isPreviewHost(u.host);
}

/** True when an unauthenticated response shows Vercel Deployment Protection in front of the page. */
export function isProtectionResponse(status: number, location: string | null, body: string): boolean {
  if ((status === 301 || status === 302 || status === 303 || status === 307 || status === 308) && location) {
    try {
      const u = new URL(location);
      return u.host === "vercel.com" && (u.pathname.startsWith("/sso-api") || u.pathname.startsWith("/login"));
    } catch {
      return false;
    }
  }
  return status === 401 && /Authentication Required|Protected by Vercel Authentication|vercel-protection/i.test(body);
}

export type HealthSample = { status: number; body: string };
export type HealthKind = "ready" | "cold-start" | "unhealthy";

/**
 * ready: 200, status ready, precomputed views on, 0 fallbacks (snapshot mode as deployed).
 * cold-start: 503 unavailable with views pending (a fresh instance still loading).
 * unhealthy: anything else, including ready-but-views-off (database mode or views disabled) and fallbacks.
 */
export function classifyHealth(s: HealthSample): { kind: HealthKind; reason?: string } {
  let j: { status?: unknown; views?: { status?: unknown; fallbacks?: unknown } };
  try {
    j = JSON.parse(s.body);
  } catch {
    return { kind: "unhealthy", reason: `HTTP ${s.status}, body is not JSON` };
  }
  if (s.status === 503 && j.status === "unavailable" && j.views?.status === "pending") return { kind: "cold-start" };
  if (s.status !== 200 || j.status !== "ready") return { kind: "unhealthy", reason: `HTTP ${s.status}, status ${String(j.status)}` };
  if (!j.views) return { kind: "unhealthy", reason: "no views diagnostic (not a Vercel Preview build?)" };
  if (j.views.status !== "on") return { kind: "unhealthy", reason: `views ${String(j.views.status)} (expected on: snapshot mode with precomputed views)` };
  if (j.views.fallbacks !== 0) return { kind: "unhealthy", reason: `views fallbacks ${String(j.views.fallbacks)}` };
  return { kind: "ready" };
}

export type HealthPolicy = {
  /** Attempts allowed before the first ready answer (covers the first cold start). */
  warmupAttempts: number;
  /** Ready answers required after warm-up. */
  polls: number;
  /** Consecutive cold-start answers tolerated during polling (a request landing on a new instance). */
  maxConsecutiveColdStarts: number;
};

export const DEFAULT_HEALTH_POLICY: HealthPolicy = { warmupAttempts: 12, polls: 10, maxConsecutiveColdStarts: 3 };

export type HealthVerdict = {
  ok: boolean;
  readyCount: number;
  coldStarts: number;
  warmupAttemptsUsed: number;
  failures: string[];
};

/**
 * Evaluates a sequence of samples against the policy. The caller feeds samples one at a time
 * (`next()` returns whether more samples are needed), so the same logic drives the live loop and tests.
 */
export function createHealthEvaluator(policy: HealthPolicy = DEFAULT_HEALTH_POLICY) {
  let warm = false;
  let warmupAttemptsUsed = 0;
  let readyCount = 0;
  let coldStarts = 0;
  let consecutiveCold = 0;
  const failures: string[] = [];
  let done = false;

  function add(sample: HealthSample): boolean {
    if (done) return false;
    const c = classifyHealth(sample);
    if (!warm) {
      warmupAttemptsUsed++;
      if (c.kind === "ready") {
        warm = true;
        readyCount = 1;
      } else if (c.kind === "cold-start") {
        coldStarts++;
      } else {
        failures.push(`warm-up: ${c.reason}`);
        done = true;
        return false;
      }
      if (!warm && warmupAttemptsUsed >= policy.warmupAttempts) {
        failures.push(`never became ready within ${policy.warmupAttempts} attempts`);
        done = true;
        return false;
      }
    } else if (c.kind === "ready") {
      readyCount++;
      consecutiveCold = 0;
    } else if (c.kind === "cold-start") {
      coldStarts++;
      consecutiveCold++;
      if (consecutiveCold > policy.maxConsecutiveColdStarts) {
        failures.push(`${consecutiveCold} consecutive cold-start answers after warm-up`);
        done = true;
        return false;
      }
    } else {
      failures.push(c.reason ?? "unhealthy");
      done = true;
      return false;
    }
    if (warm && readyCount >= policy.polls + 1) done = true;
    return !done;
  }

  function verdict(): HealthVerdict {
    return { ok: failures.length === 0 && warm && readyCount >= policy.polls + 1, readyCount, coldStarts, warmupAttemptsUsed, failures };
  }

  return { add, verdict };
}

export type BuildLogFacts = {
  guardRefused: boolean;
  buildCompleted: boolean;
  snapshotId: string | null;
  verifiedLevels: number | null;
  exportedLevels: { level: string; players: number; games: number }[];
  viewsLevels: string[];
  viewsDone: boolean;
  nextVersion: string | null;
};

/** Extracts the facts the verification needs from `vercel inspect <dpl> --logs` output. */
export function parseBuildLog(log: string): BuildLogFacts {
  const exportedLevels: BuildLogFacts["exportedLevels"] = [];
  for (const m of log.matchAll(/\[snapshot\] ([a-z0-9-]+): (\d+) players, (\d+) games/g)) {
    exportedLevels.push({ level: m[1], players: Number(m[2]), games: Number(m[3]) });
  }
  const viewsLevels = [...log.matchAll(/\[snapshot-views\] ([a-z0-9-]+): \d+ parts/g)].map((m) => m[1]);
  const verified = log.match(/\[snapshot\] verified (\d+) levels against the database read \(snapshot ([0-9a-f]+)\)/);
  const idLine = log.match(/"snapshotId":\s*"([0-9a-f]{12,64})"/);
  return {
    guardRefused: /Vercel preview build refused|Vercel build refused/i.test(log),
    buildCompleted: /Build Completed/.test(log) && /Deployment completed/.test(log),
    snapshotId: idLine?.[1] ?? verified?.[2] ?? null,
    verifiedLevels: verified ? Number(verified[1]) : null,
    exportedLevels,
    viewsLevels,
    viewsDone: /\[snapshot-views\] done:/.test(log),
    nextVersion: log.match(/Next\.js (\d+\.\d+\.\d+)/)?.[1] ?? null,
  };
}

export type RuntimeLogRecord = { level?: string; message?: string; requestPath?: string; timestamp?: string };

// Only lines known to be informational. Everything else at level error/fatal is a problem, including
// "[competition-views] precomputed views off: …", "[competition-data] load failed", "[traffic] …".
const BENIGN_RUNTIME = [
  /^\[competition-views\] precomputed views on \(snapshot [0-9a-f]+, \d+ levels\)$/,
  /^\[competition-data\] loaded /, // a successful load slower than SLOW_LOAD_MS (src/services/competition/index.ts)
];

export type RuntimeLogFacts = {
  records: number;
  startups: { snapshot: string; levels: number }[];
  problems: string[];
};

/** Separates known startup/info lines (logged on stderr, so Vercel tags them "error") from real problems. */
export function classifyRuntimeLogs(records: RuntimeLogRecord[]): RuntimeLogFacts {
  const startups: RuntimeLogFacts["startups"] = [];
  const problems: string[] = [];
  for (const r of records) {
    const msg = (r.message ?? "").trim();
    const m = msg.match(/^\[competition-views\] precomputed views on \(snapshot ([0-9a-f]+), (\d+) levels\)$/);
    if (m) startups.push({ snapshot: m[1], levels: Number(m[2]) });
    const level = (r.level ?? "").toLowerCase();
    if (BENIGN_RUNTIME.some((re) => re.test(msg))) continue;
    if (level === "error" || level === "fatal" || /Error|Unhandled|ECONN|timed out|FUNCTION_INVOCATION/i.test(msg)) {
      problems.push(`${r.timestamp ?? ""} ${r.requestPath ?? ""} ${msg.slice(0, 300)}`.trim());
    }
  }
  return { records: records.length, startups, problems };
}

const BENIGN_CONSOLE = [/vercel\.live\/_next-live\/feedback/];

/** Browser console errors that are not the app's fault (Vercel's injected Preview toolbar blocked by CSP). */
export function isBenignConsoleError(text: string): boolean {
  return BENIGN_CONSOLE.some((re) => re.test(text));
}

/** Short ids must be a prefix of the full build snapshot id (runtime logs print the first 12 hex chars). */
export function sameSnapshot(fullId: string | null, shortId: string): boolean {
  return !!fullId && shortId.length >= 8 && fullId.startsWith(shortId);
}

/** Players-page heading text per level id (labels from src/domain/levels.ts / the UI). */
export const LEVEL_LABELS: Record<string, string | null> = {
  aaa: "Triple-A",
  aa: "Double-A",
  "high-a": "High-A",
  "single-a": "Single-A",
  afl: null,
};

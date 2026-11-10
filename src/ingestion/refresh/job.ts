/**
 * One scheduled data refresh ("job"): the steps due today, each retried with bounded backoff, under
 * a job-wide lock and deadline. Framework-free and dependency-injected; the CLI
 * (scripts/refresh-data.ts) wires it to PostgreSQL and the MLB Stats API, tests to fakes.
 *
 * Every write still goes through the existing pipeline (runMilbIngestion / ingest →
 * PostgresIngestionSink): one transaction per capture, all validation, quarantine, provenance and
 * idempotency guarantees unchanged. This module only decides WHAT to run, WHEN to retry, and
 * records the outcome. Re-running a step is always safe: captures are idempotent, incremental MiLB
 * resumes from the latest stored complete game, and complete boxscores are not refetched.
 *
 * Steps, in order:
 *   milb-structure  leagues/teams/rosters/people; skipped if one was applied < structureMaxAgeHours ago
 *   milb-games      incremental schedule + boxscores for all four levels
 *   afl             full AFL season capture (small: ~2.7k records)
 * A source outside its season window (src/ingestion/refresh/schedule.ts) is skipped unless forced.
 */
import type { RefreshSource, SeasonWindow } from "./schedule";
import { ACTIVE_WINDOWS, isoDate, shouldRefresh } from "./schedule";

export type StepName = "milb-structure" | "milb-games" | "afl";
export type StepStatus = "ok" | "ok-with-quarantine" | "quarantined" | "failed" | "skipped" | "timed-out" | "aborted";

/** What a step executor reports. `failed` steps are retried; quarantine is a data problem and is not. */
export interface StepOutcome {
  status: "ok" | "ok-with-quarantine" | "quarantined" | "failed";
  /** Short, credential-free description (counts, resume point, error). */
  detail?: Record<string, unknown>;
  error?: string;
  /** false: a permanent error (e.g. HTTP 404) that retrying cannot fix. Default: retry. */
  retryable?: boolean;
}

/**
 * Permanent source errors are not retried: an HTTP 4xx other than 408 (timeout) and 429 (rate
 * limited) means the request itself is wrong (moved endpoint, bad league id) and will fail the same
 * way in five minutes. Network errors, timeouts, 5xx, 408/429 and database errors are retried.
 */
export function isPermanentError(message: string | undefined): boolean {
  if (!message) return false;
  const http = /Source HTTP (\d{3})/.exec(message);
  if (http) {
    const code = Number(http[1]);
    return code >= 400 && code < 500 && code !== 408 && code !== 429;
  }
  return /HTTPS without embedded credentials|MLB API base must be HTTPS|Date bounds must belong|Invalid (input|option)/i.test(message);
}

export interface StepRecord {
  step: StepName;
  status: StepStatus;
  attempts: number;
  durationMs: number;
  reason?: string;
  error?: string;
  detail?: Record<string, unknown>;
}

export type JobStatus =
  | "ok"
  | "ok-with-quarantine"
  | "failed"
  /** The job deadline passed. */
  | "timed-out"
  /** Stopped early: the lock's connection was lost, or the process was interrupted. */
  | "aborted"
  /** Another job holds the lock: normal overlap. */
  | "locked"
  /** Another holder has held the lock longer than maxLockHoldMs: something is stuck. */
  | "locked-stale"
  | "nothing-due"
  /** The job could not run at all (configuration, database, unexpected error). */
  | "error";

export interface JobRecord {
  jobId: string;
  startedAt: string;
  finishedAt: string;
  status: JobStatus;
  season: number;
  apply: boolean;
  /** `running` ingestion_runs rows of dead processes marked `failed`/`abandoned` at start. */
  recoveredAbandonedRuns: number;
  /** For aborted/timed-out jobs: why. */
  abortReason?: "deadline" | "lock-lost" | "interrupted";
  /** For locked/locked-stale jobs: how long the current holder has held the lock. */
  lockHeldForMinutes?: number;
  /** For status "error": a coarse, credential-free description. */
  error?: string;
  steps: StepRecord[];
}

export interface RefreshOptions {
  season: number;
  sources: RefreshSource[];
  apply: boolean;
  /** Run sources even outside their season window. */
  force: boolean;
  /** Attempts per step (≥ 1). */
  maxAttempts: number;
  /** Wait before attempt 2, 3, … (the last value repeats). Jittered by up to +20%. */
  retryDelaysMs: number[];
  /** The whole job is abandoned (between captures; an apply in progress rolls back) after this. */
  timeoutMs: number;
  /** Skip the MiLB structure capture if one was applied more recently than this. */
  structureMaxAgeHours: number;
  /** A `running` run older than this is a dead process's leftover. */
  abandonedAfterMs: number;
  /** Another holder keeping the lock longer than this is reported as `locked-stale` (exit 1). */
  maxLockHoldMs: number;
  /** Season windows (default ACTIVE_WINDOWS; PT_SEASON_WINDOWS in the CLI). */
  windows?: Record<RefreshSource, SeasonWindow>;
}

export const DEFAULT_REFRESH: Omit<RefreshOptions, "season" | "sources" | "apply" | "force"> = {
  maxAttempts: 3,
  retryDelaysMs: [60_000, 300_000],
  timeoutMs: 45 * 60_000,
  structureMaxAgeHours: 20,
  abandonedAfterMs: 2 * 60 * 60_000,
  maxLockHoldMs: 120 * 60_000,
};

export interface JobLock {
  /** Non-blocking: false when another job (or a manual apply) holds the lock. */
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}

export interface RefreshDeps {
  lock: JobLock;
  steps: Record<StepName, (signal: AbortSignal) => Promise<StepOutcome>>;
  /** When the latest MiLB structure capture was applied (null: never). */
  lastStructureAppliedAt(): Promise<Date | null>;
  /** Marks dead processes' `running` rows as failed; returns how many. Only called with the lock. */
  recoverAbandoned(olderThanMs: number): Promise<number>;
  /** How long the current lock holder has held the lock (ms), or null if unknown. */
  lockHolderAgeMs?(): Promise<number | null>;
  /** Fires when the process is asked to stop (SIGINT/SIGTERM). */
  interrupt?: AbortSignal;
  clock?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Fires when the job lock's connection is lost (the job must stop: another could start). */
  lockLost?: AbortSignal;
  log?: (event: string, data?: Record<string, string | number | boolean | undefined>) => void;
  jobId?: string;
}

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** Which steps a job runs today, and why the others are skipped. */
export function planSteps(
  o: Pick<RefreshOptions, "sources" | "force" | "structureMaxAgeHours" | "windows">,
  today: string,
  lastStructure: Date | null,
  now: Date,
): { step: StepName; run: boolean; reason?: string }[] {
  const due = (s: RefreshSource) => o.sources.includes(s) && (o.force || shouldRefresh(s, today, o.windows ?? ACTIVE_WINDOWS));
  const why = (s: RefreshSource) => (o.sources.includes(s) ? "off-season" : "not selected");
  const structureFresh =
    lastStructure !== null && now.getTime() - lastStructure.getTime() < o.structureMaxAgeHours * 3_600_000;
  return [
    due("milb")
      ? structureFresh
        ? { step: "milb-structure", run: false, reason: "structure-recent" }
        : { step: "milb-structure", run: true }
      : { step: "milb-structure", run: false, reason: why("milb") },
    due("milb") ? { step: "milb-games", run: true } : { step: "milb-games", run: false, reason: why("milb") },
    due("afl") ? { step: "afl", run: true } : { step: "afl", run: false, reason: why("afl") },
  ];
}

export async function runRefreshJob(o: RefreshOptions, deps: RefreshDeps): Promise<JobRecord> {
  const clock = deps.clock ?? (() => new Date());
  const sleep = deps.sleep ?? abortableSleep;
  const random = deps.random ?? Math.random;
  const log = deps.log ?? (() => {});
  const started = clock();
  const record: JobRecord = {
    jobId: deps.jobId ?? `${started.toISOString()}-${Math.floor(random() * 1e6)}`,
    startedAt: started.toISOString(),
    finishedAt: "",
    status: "ok",
    season: o.season,
    apply: o.apply,
    recoveredAbandonedRuns: 0,
    steps: [],
  };
  const finish = (status: JobStatus) => {
    record.status = status;
    record.finishedAt = clock().toISOString();
    log("job:finished", { status, steps: record.steps.map((s) => `${s.step}:${s.status}`).join(",") });
    return record;
  };

  if (!(await deps.lock.acquire())) {
    const age = (await deps.lockHolderAgeMs?.().catch(() => null)) ?? null;
    if (age !== null) record.lockHeldForMinutes = Math.round(age / 60_000);
    // Normal overlap (exit 0, no ping) unless the holder has held the lock for too long.
    const stale = age !== null && age > o.maxLockHoldMs;
    log(stale ? "job:locked-stale" : "job:locked", { heldForMinutes: record.lockHeldForMinutes });
    return finish(stale ? "locked-stale" : "locked");
  }
  // The deadline, a lost lock and an interrupt all stop the job. They are checked between attempts
  // and passed to steps, whose sink stops before its next apply (an apply in progress commits or
  // rolls back as a whole; nothing partial is written).
  const deadline = AbortSignal.timeout(o.timeoutMs);
  const signal = AbortSignal.any([deadline, ...(deps.lockLost ? [deps.lockLost] : []), ...(deps.interrupt ? [deps.interrupt] : [])]);
  const abortReason = (): JobRecord["abortReason"] =>
    deps.lockLost?.aborted ? "lock-lost" : deps.interrupt?.aborted ? "interrupted" : "deadline";
  try {
    if (o.apply) {
      record.recoveredAbandonedRuns = await deps.recoverAbandoned(o.abandonedAfterMs);
      if (record.recoveredAbandonedRuns) log("job:recovered-abandoned", { runs: record.recoveredAbandonedRuns });
    }
    const plan = planSteps(o, isoDate(started), await deps.lastStructureAppliedAt(), started);
    if (!plan.some((p) => p.run)) {
      for (const p of plan) record.steps.push({ step: p.step, status: "skipped", attempts: 0, durationMs: 0, reason: p.reason });
      return finish("nothing-due");
    }
    for (const p of plan) {
      if (!p.run) {
        record.steps.push({ step: p.step, status: "skipped", attempts: 0, durationMs: 0, reason: p.reason });
        continue;
      }
      const stepRecord = await runStep(p.step, o, deps.steps[p.step], signal, sleep, random, clock, log);
      if (stepRecord.status === "timed-out") {
        record.abortReason = abortReason();
        if (record.abortReason !== "deadline") stepRecord.status = "aborted";
        record.steps.push(stepRecord);
        return finish(record.abortReason === "deadline" ? "timed-out" : "aborted");
      }
      record.steps.push(stepRecord);
      // A failed MiLB structure capture does not block games: games reuse stored structure and the
      // pipeline quarantines anything it cannot resolve. Every step's outcome is recorded.
    }
    const statuses = record.steps.map((s) => s.status);
    return finish(
      statuses.includes("failed") || statuses.includes("quarantined")
        ? "failed"
        : statuses.includes("ok-with-quarantine")
          ? "ok-with-quarantine"
          : "ok",
    );
  } finally {
    await deps.lock.release();
  }
}

async function runStep(
  step: StepName,
  o: RefreshOptions,
  exec: (signal: AbortSignal) => Promise<StepOutcome>,
  signal: AbortSignal,
  sleep: NonNullable<RefreshDeps["sleep"]>,
  random: () => number,
  clock: () => Date,
  log: NonNullable<RefreshDeps["log"]>,
): Promise<StepRecord> {
  const t0 = clock().getTime();
  let last: StepOutcome | undefined;
  for (let attempt = 1; attempt <= Math.max(1, o.maxAttempts); attempt++) {
    if (signal.aborted)
      return { step, status: "timed-out", attempts: attempt - 1, durationMs: clock().getTime() - t0, error: last?.error };
    log("step:attempt", { step, attempt });
    try {
      last = await exec(signal);
    } catch (error) {
      if (signal.aborted)
        return { step, status: "timed-out", attempts: attempt, durationMs: clock().getTime() - t0, error: errorText(error) };
      last = { status: "failed", error: errorText(error) };
    }
    if (last.status !== "failed")
      return { step, status: last.status, attempts: attempt, durationMs: clock().getTime() - t0, detail: last.detail };
    log("step:failed", { step, attempt, error: last.error });
    if (last.retryable === false || isPermanentError(last.error)) {
      log("step:permanent-error", { step });
      return { step, status: "failed", attempts: attempt, durationMs: clock().getTime() - t0, error: last.error, detail: { ...last.detail, permanent: true } };
    }
    if (attempt < o.maxAttempts) {
      const base = o.retryDelaysMs[Math.min(attempt - 1, o.retryDelaysMs.length - 1)] ?? 0;
      const wait = Math.round(base * (1 + 0.2 * random()));
      log("step:retry-wait", { step, ms: wait });
      try {
        await sleep(wait, signal);
      } catch {
        return { step, status: "timed-out", attempts: attempt, durationMs: clock().getTime() - t0, error: last.error };
      }
    }
  }
  return { step, status: "failed", attempts: Math.max(1, o.maxAttempts), durationMs: clock().getTime() - t0, error: last?.error, detail: last?.detail };
}

export function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** Process exit code for a scheduler: 0 done (or nothing due / normal overlap), 1 needs attention. */
export const jobExitCode = (r: Pick<JobRecord, "status">) =>
  r.status === "ok" || r.status === "ok-with-quarantine" || r.status === "nothing-due" || r.status === "locked" ? 0 : 1;

/** Whether the dead-man's-switch ping should fire, and how: normal overlap and dry runs do not ping. */
export function pingKind(r: Pick<JobRecord, "status" | "apply">): "success" | "fail" | null {
  if (r.status === "error") return "fail";
  if (!r.apply || r.status === "locked") return null;
  return jobExitCode(r) === 0 ? "success" : "fail";
}

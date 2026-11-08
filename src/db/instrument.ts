/**
 * Credential-safe timing instrumentation and a stalled-query watchdog for a pg Pool.
 *
 * Timing: every query on an instrumented pool records, from the client's socket, when it was sent,
 * when bytes arrived (first, last, and the longest silence between two chunks, with how many bytes
 * had arrived before it), how many bytes came back, and when pg finished parsing the result. That
 * separates server execution (silence before the result streams), network transfer (time and
 * gaps while bytes stream), and client parsing (last byte → resolved). Pool acquire (waiting for or
 * opening a connection) is timed too. Records are attributed to the current trace
 * (AsyncLocalStorage), e.g. one competition level load. Only a short query label (statement kind
 * and first table) is kept: never SQL parameters, connection strings or error text.
 *
 * Watchdog: a query whose connection has received no bytes for `stallMs`, that has been receiving
 * for longer than `slowAfterMs` at under `minBytesPerSec`, or that has not completed after
 * `queryDeadlineMs`, has its socket destroyed. pg then fails the query and the transaction
 * (the rollback fails fast on the closed client) and the pool discards the connection, so a
 * stalled read cannot hold a request or a pool slot for minutes. pg's own query_timeout is not
 * enough: it rejects the promise but leaves the connection busy until the reply finally arrives.
 *
 * Why a no-progress rule: measured on the Neon test branch, healthy transfers never paused more
 * than ~0.8 s between chunks, while a degraded connection paused 4.5 s, 9 s, 18 s (TCP
 * retransmission backoff) and delivered ~15 kB/s for minutes although the server had finished in
 * under a second. Degraded connections also trickled at 10-19 kB/s with 1.6-5 s gaps (never
 * silent long enough for the stall rule), while every healthy query >100 kB ran at >=127 kB/s and
 * finished within ~4 s. A fresh connection does not inherit the degradation (retries completed in
 * 4-6 s), so closing early and retrying (tracedLevelLoader) recovers in seconds.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";

export interface QueryTiming {
  label: string;
  /** Sent → first response byte (parse/bind replies arrive before execution finishes). */
  firstByteMs: number | null;
  /** Sent → last response byte. */
  lastByteMs: number | null;
  /** Sent → result returned by pg (includes client-side row parsing). */
  totalMs: number;
  bytes: number;
  chunks: number;
  /** Longest silence between consecutive chunks, and the bytes received before it. */
  maxGapMs: number;
  bytesBeforeMaxGap: number;
  /** "ok", or "error" (any failure) / "deadline" (destroyed by the watchdog). */
  outcome: "ok" | "error" | WatchdogReason;
}

export type WatchdogReason = "deadline" | "stalled" | "slow";

export interface LoadTrace {
  name: string;
  startedAt: number;
  /** Process pauses (event loop not running: blocked, or the machine asleep) during the trace. */
  pausesMs?: number[];
  acquireMs: number[];
  queries: QueryTiming[];
  /** Named application phases (decode, prepare, …), in ms. */
  phases: Record<string, number>;
}

const store = new AsyncLocalStorage<LoadTrace>();

export function newTrace(name: string): LoadTrace {
  return { name, startedAt: performance.now(), acquireMs: [], queries: [], phases: {} };
}

/** Runs `fn` with `trace` as the current trace (queries and phases inside are attributed to it). */
export const withTrace = <T>(trace: LoadTrace, fn: () => Promise<T>) => store.run(trace, fn);

/** The current trace, if any (diagnostics and tests). */
export const currentTrace = () => store.getStore();

/** Adds `ms` to a named phase of the current trace, if any. */
export function addPhase(name: string, ms: number) {
  const t = store.getStore();
  if (t) t.phases[name] = (t.phases[name] ?? 0) + ms;
}

/** Times a synchronous application phase into the current trace. */
export function timePhase<T>(name: string, fn: () => T): T {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    addPhase(name, performance.now() - t0);
  }
}

/** "select:player_batting_games", "with:player_batting_games", "begin" — no parameters. */
export function queryLabel(text: string): string {
  const t = text.trim();
  const kind = (/^[a-z]+/i.exec(t)?.[0] ?? "query").toLowerCase();
  const table = /\bfrom\s+"?([a-z_][a-z0-9_]*)"?/i.exec(t)?.[1];
  return table ? `${kind}:${table}` : kind;
}

export interface InstrumentOptions {
  /** Destroy the connection of a query still running after this long. 0 disables. */
  queryDeadlineMs: number;
  /** Destroy the connection of a query that received no bytes for this long. 0 disables. */
  stallMs?: number;
  /** Destroy the connection of a query receiving for longer than `slowAfterMs` (measured from its
   *  first byte) at an average below `minBytesPerSec`. Either 0 disables. */
  slowAfterMs?: number;
  minBytesPerSec?: number;
  /** Watchdog sweep interval. */
  sweepMs?: number;
  onDeadline?: (label: string, elapsedMs: number, reason: WatchdogReason) => void;
}

const INSTRUMENTED = Symbol.for("prospect-terminal.pg-instrumented");

interface Active {
  label: string;
  sentAt: number;
  /** Last time bytes arrived (or the watchdog last observed the process running). */
  lastDataAt: number;
  /** First response byte, and bytes received since. */
  firstDataAt: number | null;
  bytes: number;
  client: PoolClient;
  destroyed: WatchdogReason | null;
}

/** Instruments `pool` once (idempotent). Returns a function that stops the watchdog. */
export function instrumentPool(pool: Pool, opts: InstrumentOptions): () => void {
  const marked = pool as Pool & { [INSTRUMENTED]?: () => void };
  if (marked[INSTRUMENTED]) return marked[INSTRUMENTED];
  const active = new Set<Active>();

  const connect = pool.connect.bind(pool) as () => Promise<PoolClient>;
  (pool as unknown as { connect: unknown }).connect = (...args: unknown[]) => {
    if (args.length) return (connect as (...a: unknown[]) => unknown)(...args); // callback form: untouched
    const trace = store.getStore();
    const t0 = performance.now();
    return connect().then((client) => {
      trace?.acquireMs.push(performance.now() - t0);
      wrapClient(client);
      return client;
    });
  };

  const wrapped = new WeakSet<PoolClient>();
  function wrapClient(client: PoolClient) {
    if (wrapped.has(client)) return;
    wrapped.add(client);
    // pg-pool only listens for errors on IDLE clients. A checked-out client whose socket fails (or
    // is closed by the watchdog below) emits 'error' on the client; unhandled, that crashes the
    // whole Node process. The failure still reaches the caller through the rejected query, and
    // the pool discards the client on release.
    client.on("error", () => {});
    const query = client.query.bind(client) as (...a: unknown[]) => unknown;
    (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
      const first = args[0] as string | { text?: string } | undefined;
      const text = typeof first === "string" ? first : (first?.text ?? "");
      const result = query(...args);
      if (!result || typeof (result as Promise<unknown>).then !== "function") return result; // callback/stream forms
      const trace = store.getStore();
      const stream = (client as unknown as { connection?: { stream?: NodeJS.EventEmitter } }).connection?.stream;
      const sentAt = performance.now();
      const timing: QueryTiming = {
        label: queryLabel(text),
        firstByteMs: null,
        lastByteMs: null,
        totalMs: 0,
        bytes: 0,
        chunks: 0,
        maxGapMs: 0,
        bytesBeforeMaxGap: 0,
        outcome: "ok",
      };
      let last = sentAt;
      const onData = (chunk: Buffer) => {
        const now = performance.now();
        entry.lastDataAt = now;
        entry.firstDataAt ??= now;
        entry.bytes += chunk.length;
        if (now - last > timing.maxGapMs) {
          timing.maxGapMs = now - last;
          timing.bytesBeforeMaxGap = timing.bytes;
        }
        last = now;
        timing.firstByteMs ??= now - sentAt;
        timing.lastByteMs = now - sentAt;
        timing.bytes += chunk.length;
        timing.chunks++;
      };
      const entry: Active = {
        label: timing.label,
        sentAt,
        lastDataAt: sentAt,
        firstDataAt: null,
        bytes: 0,
        client,
        destroyed: null,
      };
      stream?.on("data", onData);
      active.add(entry);
      const done = (outcome: QueryTiming["outcome"]) => {
        stream?.off("data", onData);
        active.delete(entry);
        timing.totalMs = performance.now() - sentAt;
        timing.outcome = entry.destroyed ?? outcome;
        trace?.queries.push(timing);
      };
      (result as Promise<unknown>).then(
        () => done("ok"),
        () => done("error"),
      );
      return result;
    };
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  const sweepMs = opts.sweepMs ?? 1_000;
  const stallMs = opts.stallMs ?? 0;
  const slowAfterMs = opts.slowAfterMs ?? 0;
  const minRate = opts.minBytesPerSec ?? 0;
  if (opts.queryDeadlineMs > 0 || stallMs > 0 || (slowAfterMs > 0 && minRate > 0)) {
    let lastSweep = performance.now();
    timer = setInterval(() => {
      const now = performance.now();
      const late = now - lastSweep - sweepMs;
      lastSweep = now;
      for (const a of active) {
        if (a.destroyed) continue;
        // The process itself did not run (machine asleep or event loop blocked): bytes could not
        // be observed, so silence is not evidence of a stall. Restart the idle clocks.
        if (late > sweepMs) {
          a.lastDataAt = now;
          if (a.firstDataAt !== null) {
            // Restart the rate window too: bytes could not be read while paused.
            a.firstDataAt = now;
            a.bytes = 0;
          }
          continue;
        }
        const receiving = a.firstDataAt === null ? 0 : now - a.firstDataAt;
        const reason: WatchdogReason | null =
          opts.queryDeadlineMs > 0 && now - a.sentAt > opts.queryDeadlineMs
            ? "deadline"
            : stallMs > 0 && now - a.lastDataAt > stallMs
              ? "stalled"
              : slowAfterMs > 0 && minRate > 0 && receiving > slowAfterMs && (a.bytes * 1000) / receiving < minRate
                ? "slow"
                : null;
        if (!reason) continue;
        a.destroyed = reason;
        opts.onDeadline?.(a.label, now - a.sentAt, reason);
        (a.client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
      }
    }, sweepMs);
    timer.unref?.();
  }
  const stop = () => {
    if (timer) clearInterval(timer);
  };
  marked[INSTRUMENTED] = stop;
  return stop;
}

// ---------------------------------------------------------------------------------------------
// Process pause monitor: a 500 ms tick. A tick arriving much later than scheduled means the event
// loop did not run (synchronous work blocked it, or the process/machine was suspended). Network
// or database waits never delay ticks, so this separates "the process stopped" from "it waited".

const TICK_MS = 500;
const PAUSE_MS = 1_000;
const pauses: { at: number; ms: number }[] = [];
let monitor: ReturnType<typeof setInterval> | undefined;

/** Starts the process-wide pause monitor (idempotent; unref'd, never keeps the process alive). */
export function startPauseMonitor() {
  if (monitor) return;
  let last = performance.now();
  monitor = setInterval(() => {
    const now = performance.now();
    const late = now - last - TICK_MS;
    if (late > PAUSE_MS) {
      pauses.push({ at: now, ms: late });
      if (pauses.length > 100) pauses.shift();
    }
    last = now;
  }, TICK_MS);
  monitor.unref?.();
}

/** Pauses that ended within [from, to] (performance.now() times). */
export function pausesBetween(from: number, to: number) {
  return pauses.filter((p) => p.at >= from && p.at - p.ms <= to).map((p) => p.ms);
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const s = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

/** One-line, credential-free summary of a trace (for logs). */
export function summarizeTrace(t: LoadTrace, totalMs = performance.now() - t.startedAt): string {
  const q = t.queries;
  const bytes = sum(q.map((x) => x.bytes));
  const transfer = sum(q.map((x) => (x.lastByteMs ?? 0) - (x.firstByteMs ?? 0)));
  const waits = sum(q.map((x) => x.firstByteMs ?? x.totalMs));
  const parse = sum(q.map((x) => x.totalMs - (x.lastByteMs ?? x.totalMs)));
  const worst = [...q].sort((a, b) => b.totalMs - a.totalMs)[0];
  const phases = Object.entries(t.phases)
    .map(([k, v]) => `${k} ${s(v)}`)
    .join(", ");
  const failed = q.filter((x) => x.outcome !== "ok").length;
  const paused = t.pausesMs ?? pausesBetween(t.startedAt, t.startedAt + totalMs);
  return (
    `${t.name} ${s(totalMs)}: acquire ${s(sum(t.acquireMs))} (${t.acquireMs.length}), ` +
    `${q.length} queries, first-byte waits ${s(waits)}, transfer ${s(transfer)} ${(bytes / 1e6).toFixed(2)}MB, ` +
    `pg parse ${s(parse)}${phases ? `, ${phases}` : ""}` +
    (worst
      ? `; slowest ${worst.label} ${s(worst.totalMs)} (first byte ${s(worst.firstByteMs ?? 0)}, ` +
        `longest gap ${s(worst.maxGapMs)} after ${worst.bytesBeforeMaxGap}B, ${worst.bytes}B)`
      : "") +
    (failed ? `; ${failed} failed` : "") +
    (paused.length ? `; PROCESS PAUSED ${s(sum(paused))} (${paused.length}x)` : "")
  );
}

import "server-only";
import { connection } from "next/server";
import { getDatabase } from "@/db/client";
import { loadAflSnapshot } from "./queries";
import type { AflDataResult } from "./types";

export type { AflDataResult, AflSnapshot } from "./types";

/**
 * Ingestion writes only on explicit CLI applies, so a short process-level reuse window avoids a
 * Neon round trip set on every request while keeping data effectively current.
 */
const REUSE_MS = 60_000;
let cached: { at: number; promise: Promise<AflDataResult> } | undefined;

/** Only a coarse, credential-free code is ever logged. */
function safeErrorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error)
    return String((error as { code: unknown }).code).slice(0, 16);
  return error instanceof Error ? error.name : "unknown";
}

async function read(): Promise<AflDataResult> {
  if (!process.env.DATABASE_URL) return { status: "not-configured" };
  try {
    const snapshot = await loadAflSnapshot(getDatabase());
    return snapshot ? { status: "ok", snapshot } : { status: "empty" };
  } catch (error) {
    console.error(`[afl-data] read failed (${safeErrorCode(error)})`);
    return { status: "unavailable" };
  }
}

/**
 * Server-side entry point for real AFL data. Never import from a Client Component:
 * the database client and DATABASE_URL stay on the server ("server-only" enforces this).
 */
export async function getAflData(): Promise<AflDataResult> {
  await connection(); // request-time data; never prerendered into the build output
  const now = Date.now();
  if (!cached || now - cached.at > REUSE_MS) {
    const promise = read();
    cached = { at: now, promise };
    // Failures are not reused, so the next request retries immediately.
    promise.then((r) => {
      if (r.status !== "ok" && cached?.promise === promise) cached = undefined;
    });
  }
  return cached.promise;
}

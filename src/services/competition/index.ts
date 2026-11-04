import "server-only";
import { connection } from "next/server";
import { getDatabase } from "@/db/client";
import { AFL } from "@/ingestion/sources/mlb-config";
import { dbLevelLoader, loadCompetition } from "./load";
import type { CompetitionDataResult } from "./types";

export type { CompetitionDataResult, LevelSnapshot } from "./types";

/**
 * Season shown on the site. The AFL (`afl-{year}`) and MiLB (`milb-{year}`) seasons are separate
 * seasons in the database; both are read for this year.
 */
export const DATA_SEASON: number = AFL.defaultSeason;

/**
 * Ingestion writes only on explicit CLI applies, so a short process-level reuse window avoids
 * re-reading every level on every request while keeping data effectively current.
 */
const REUSE_MS = 60_000;
let cached: { at: number; promise: Promise<CompetitionDataResult> } | undefined;

/** Only a coarse, credential-free code is ever logged. */
export function safeErrorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error)
    return String((error as { code: unknown }).code).slice(0, 16);
  return error instanceof Error ? error.name : "unknown";
}

async function read(): Promise<CompetitionDataResult> {
  if (!process.env.DATABASE_URL) return { status: "not-configured" };
  try {
    return await loadCompetition(
      dbLevelLoader(getDatabase(), DATA_SEASON),
      (level, error) =>
        console.error(`[competition-data] ${level} read failed (${safeErrorCode(error)})`),
    );
  } catch (error) {
    console.error(`[competition-data] read failed (${safeErrorCode(error)})`);
    return { status: "unavailable" };
  }
}

/**
 * Server-side entry point for real data at every level (AFL + Triple-A … Single-A). Never import
 * from a Client Component: the database client stays on the server ("server-only" enforces this).
 */
export async function getCompetitionData(): Promise<CompetitionDataResult> {
  await connection(); // request-time data; never prerendered into the build output
  const now = Date.now();
  if (!cached || now - cached.at > REUSE_MS) {
    const promise = read();
    cached = { at: now, promise };
    // Failed or partial reads are not reused, so the next request retries immediately.
    promise.then((r) => {
      const partial =
        r.status === "ok" && Object.values(r.levelStatus).includes("unavailable");
      if ((r.status !== "ok" && r.status !== "empty") || partial)
        if (cached?.promise === promise) cached = undefined;
    });
  }
  return cached.promise;
}

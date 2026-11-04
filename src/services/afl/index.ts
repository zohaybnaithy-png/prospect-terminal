import "server-only";
import { getCompetitionData } from "@/services/competition";
import type { AflDataResult } from "./types";

export type { AflDataResult, AflSnapshot } from "./types";

/**
 * AFL-only view of the shared competition data (one cached read for every level). Used by the
 * development model-comparison page; the public pages read getCompetitionData directly.
 */
export async function getAflData(): Promise<AflDataResult> {
  const data = await getCompetitionData();
  if (data.status === "not-configured" || data.status === "unavailable")
    return { status: data.status };
  if (data.status === "empty") return { status: "empty" };
  const afl = data.levels.find((l) => l.level === "afl");
  if (afl) return { status: "ok", snapshot: afl.snapshot };
  return { status: data.levelStatus.afl === "unavailable" ? "unavailable" : "empty" };
}

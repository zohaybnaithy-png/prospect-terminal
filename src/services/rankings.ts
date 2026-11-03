/**
 * Overall (MLB-wide) top-prospect rankings boundary.
 *
 * No licensed or first-party ranking source is integrated yet, and Prospect Terminal does not
 * have a finalized Prospect Grade. Until one exists this returns "unavailable" so the homepage
 * shows an honest empty state instead of a fabricated list. A future source (a licensed list or
 * an approved internal model) only needs to return the "ok" shape.
 */
export interface RankedProspect {
  rank: number;
  playerId: string | null;
  name: string;
  position: string;
  organization: string | null;
  level: string | null;
}

export type TopProspectsResult =
  | {
      status: "ok";
      source: string;
      asOf: string;
      entries: RankedProspect[];
    }
  | { status: "unavailable"; reason: string };

export async function getTopProspects(): Promise<TopProspectsResult> {
  return {
    status: "unavailable",
    reason:
      "No licensed ranking source is connected and the Prospect Grade model is still in development.",
  };
}

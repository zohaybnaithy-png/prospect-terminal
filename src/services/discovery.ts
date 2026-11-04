/** Fictional demo fixture access for tests and the dev seed only; not used by user-facing routes. */
import { demoDiscoveryOrder, DEMO_AS_OF } from "@/data/demo";
import { ageOn } from "@/lib/format";
import type {
  Catalog,
  DiscoveryFilters,
  Player,
  TimeWindow,
} from "@/types/baseball";
export const windowLabels: Record<TimeWindow, string> = {
  "7d": "Last 7 days",
  "14d": "Last 14 days",
  "30d": "Last 30 days",
  season: "Season",
};
export const defaultFilters: DiscoveryFilters = {
  ranking: "priority",
  context: "all",
  window: "14d",
  type: "all",
  query: "",
  organization: "",
  team: "",
  minGrade: 0,
  minMomentum: null,
  maxAge: null,
  position: "",
};
/** A fixture lookup + filters, NOT a performance-ranking formula.
 * A future real DiscoveryRepository must replace this with validated game-window data
 * and an independently specified ranking method. No level weights are assigned here. */
export function discoverDemoPlayers(
  catalog: Catalog,
  filters: DiscoveryFilters,
): Player[] {
  const byId = new Map(catalog.players.map((p) => [p.id, p]));
  return demoDiscoveryOrder[filters.window][filters.ranking].flatMap((id) => {
    const p = byId.get(id);
    if (!p) return [];
    const team = catalog.teams.find((t) => t.id === p.teamId);
    const context = catalog.contexts.find((c) => c.id === team?.contextId);
    const organization = catalog.organizations.find(
      (o) => o.id === p.organizationId,
    );
    const sample = p.performance[filters.window];
    if (filters.context !== "all" && context?.slug !== filters.context)
      return [];
    if (
      (filters.type === "hitters" && !sample.batting) ||
      (filters.type === "pitchers" && !sample.pitching)
    )
      return [];
    if (
      (filters.organization && p.organizationId !== filters.organization) ||
      (filters.team && p.teamId !== filters.team)
    )
      return [];
    if (filters.position && p.position !== filters.position) return [];
    if (
      p.grade < filters.minGrade ||
      (filters.minMomentum !== null && p.momentum < filters.minMomentum) ||
      (filters.maxAge !== null &&
        ageOn(p.birthDate, DEMO_AS_OF) > filters.maxAge)
    )
      return [];
    if (
      !`${p.name} ${team?.name} ${organization?.name}`
        .toLowerCase()
        .includes(filters.query.trim().toLowerCase())
    )
      return [];
    return [p];
  });
}

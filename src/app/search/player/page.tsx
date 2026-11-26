import { redirect } from "next/navigation";
import { getCompetitionData } from "@/services/competition";
import { levelDirectoryRows } from "@/services/players/adapter";
import { isLevelId } from "@/services/players/levels";
import { resolveNameKey } from "@/services/search/name-index";
import { playerHref } from "@/components/ui/entity-links";
import { QUERY_MAX_LENGTH } from "@/services/players/directory-query";

/**
 * Where a header typeahead suggestion goes (T-205): `?level=&id=<short key>&q=<name>`. The key is
 * resolved against the same level's players and the visitor is redirected to the canonical
 * profile URL. Anything that does not resolve to exactly one player (a key from an older
 * deployment's index, a malformed URL, a level that is not loaded) lands on the directory search
 * for the name instead, so a pick never dead-ends. Renders nothing itself.
 */
type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function SearchPlayer({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const level = one(params.level);
  const key = one(params.id).toLowerCase();
  const name = one(params.q).trim().slice(0, QUERY_MAX_LENGTH);
  let target: string | null = null;
  if (isLevelId(level)) {
    const data = await getCompetitionData();
    const ls = data.status === "ok" ? data.levels.find((l) => l.level === level) : undefined;
    const id = ls ? resolveNameKey(levelDirectoryRows(ls.snapshot, level, "season").map((r) => r.id), key) : null;
    if (id) target = playerHref(id, level);
  }
  const fallback = new URLSearchParams();
  if (isLevelId(level)) fallback.set("level", level);
  if (name) fallback.set("q", name);
  redirect(target ?? `/players${fallback.size ? `?${fallback}` : ""}`);
}

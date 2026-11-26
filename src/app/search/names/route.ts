import { getCompetitionData } from "@/services/competition";
import { levelDirectoryRows } from "@/services/players/adapter";
import { isLevelId } from "@/services/players/levels";
import { buildNameIndex, type NameIndex } from "@/services/search/name-index";
import { processWeakMap } from "@/lib/process-memo";
import { cdnHeadersFor } from "@/lib/cdn-cache";
import type { AflSnapshot } from "@/services/afl/types";

/**
 * The header typeahead's name index for one level (T-205): `?level=<id>`. Every player with a
 * line at that level, as in the directory. Fetched once per level per page session by the
 * browser (never per keystroke). Read-only, from the in-memory level cache.
 */
const NOT_CACHED = { "Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store" };
const memo = processWeakMap<AflSnapshot, string>("name-index");

export async function GET(request: Request) {
  const level = new URL(request.url).searchParams.get("level") ?? "";
  if (!isLevelId(level)) return Response.json({ error: "bad-request" }, { status: 400 });
  const data = await getCompetitionData();
  if (data.status !== "ok") return Response.json({ error: data.status }, { status: 503, headers: NOT_CACHED });
  const ls = data.levels.find((l) => l.level === level);
  if (!ls) return Response.json({ error: "not-loaded" }, { status: 404, headers: NOT_CACHED });
  let body = memo.get(ls.snapshot);
  if (!body) {
    const index: NameIndex = buildNameIndex(levelDirectoryRows(ls.snapshot, level, "season"), level);
    memo.set(ls.snapshot, (body = JSON.stringify(index)));
  }
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      // Same as /trends/data: CDN-cached only on success, for plain requests (src/lib/cdn-cache.ts).
      "Cache-Control": "private, max-age=300",
      ...cdnHeadersFor(request),
    },
  });
}

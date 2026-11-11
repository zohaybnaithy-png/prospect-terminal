import { MOMENTUM_WINDOW_IDS, type MomentumWindow, type Role } from "@/analytics/config";
import { getCompetitionData } from "@/services/competition";
import { trendMapPoints, trendRiserLists } from "@/services/competition/prepare";
import { isLevelId } from "@/services/players/levels";

/**
 * One role × window of a Trends view for one level, fetched when the viewer switches role or
 * window (the page embeds only the default selection, hitters · 14D):
 *   ?view=risers  → risers and fallers for every category
 *   ?view=map     → Performance × Momentum points
 * Served from the in-memory level cache; read-only.
 */
/** Data-state answers must never be kept by Vercel's CDN (src/lib/cdn-cache.ts). */
const NOT_CACHED = { "Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store" };

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const view = params.get("view");
  const level = params.get("level") ?? "";
  const role = params.get("role") as Role;
  const window = params.get("window") as MomentumWindow;
  if (
    (view !== "map" && view !== "risers") ||
    !isLevelId(level) ||
    !["hitter", "pitcher"].includes(role) ||
    !MOMENTUM_WINDOW_IDS.includes(window)
  )
    return Response.json({ error: "bad-request" }, { status: 400 });
  const data = await getCompetitionData();
  if (data.status !== "ok") return Response.json({ error: data.status }, { status: 503, headers: NOT_CACHED });
  const ls = data.levels.find((l) => l.level === level);
  if (!ls) return Response.json({ error: "not-loaded" }, { status: 404, headers: NOT_CACHED });
  return Response.json(
    view === "map"
      ? trendMapPoints(ls.snapshot, role, window)
      : trendRiserLists(ls.snapshot, role, window),
    { headers: { "Cache-Control": "private, max-age=60" } },
  );
}

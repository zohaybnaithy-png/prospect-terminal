import type { MetadataRoute } from "next";
import type { LevelSnapshot } from "@/services/competition/types";

/**
 * Sitemap entries: static pages, then every player who has at least one batting or pitching line
 * at any level (the players who have a profile), once each, at the canonical query-free URL.
 * `lastModified` is the latest ingestion that contained the player's level (when known). Linear in
 * the number of stat lines; well under the 50,000-URL sitemap limit at full MiLB scale (~3.3k).
 */
export function sitemapEntries(
  origin: string,
  pages: readonly string[],
  levels: LevelSnapshot[],
): MetadataRoute.Sitemap {
  const lastSeen = new Map<string, string | null>();
  for (const { snapshot } of levels) {
    const at = snapshot.lastIngestedAt;
    const note = (id: string) => {
      const prev = lastSeen.get(id);
      if (prev === undefined || (at && (!prev || at > prev))) lastSeen.set(id, at);
    };
    for (const l of snapshot.batting) note(l.playerId);
    for (const l of snapshot.pitching) note(l.playerId);
  }
  const latest = [...lastSeen.values()].filter((v): v is string => !!v).sort().at(-1);
  return [
    ...pages.map((path) => ({
      url: `${origin}${path === "/" ? "" : path}`,
      ...(latest ? { lastModified: latest } : {}),
    })),
    ...[...lastSeen].sort(([a], [b]) => a.localeCompare(b)).map(([id, at]) => ({
      url: `${origin}/players/${id}`,
      ...(at ? { lastModified: at } : {}),
    })),
  ];
}

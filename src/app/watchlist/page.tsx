import type { Metadata } from "next";
import Link from "@/components/ui/app-link";
import { PageHeading } from "@/components/ui/primitives";
import { AflDataNotice } from "@/components/afl/data-notice";
import { PlayerLink } from "@/components/ui/entity-links";
import { WatchlistStar } from "@/components/watchlist/star-button";
import { WatchlistSync } from "@/components/watchlist/watchlist-sync";
import { WatchlistTable } from "@/components/watchlist/watchlist-table";
import { DEFAULT_MOMENTUM_WINDOW, MOMENTUM_WINDOWS } from "@/analytics/config";
import { getCompetitionData } from "@/services/competition";
import { watchlistView, type WatchlistView } from "@/services/watchlist/model";
import { parseWatchlistQuery } from "@/services/watchlist/query";

export const metadata: Metadata = {
  title: "Watchlist",
  // A personal view of other pages: never indexed; every `?ids=` variant is the same page.
  alternates: { canonical: "/watchlist" },
  robots: { index: false, follow: true },
  description: "Players starred in this browser, with their latest level's season line and Momentum.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * `/watchlist?ids=<uuid,…>`. Rendered from the query string only, so it is the same for every
 * visitor and CDN-cacheable; the stars themselves stay in this browser (WatchlistSync puts them
 * into the URL). Bad or unknown ids give a notice, never a 404.
 */
export default async function WatchlistPage({ searchParams }: { searchParams: SearchParams }) {
  const [data, params] = await Promise.all([getCompetitionData(), searchParams]);
  const query = parseWatchlistQuery(params);
  return (
    <>
      <Link href="/players" className="back-link">
        ← Players
      </Link>
      <PageHeading
        title="Watchlist"
        description="Players you starred in this browser, each with the season line and Momentum from the level of their most recent game. Levels are different competitions and are never blended."
      />
      {data.status !== "ok" ? (
        <AflDataNotice status={data.status} />
      ) : (
        <>
          <WatchlistSync urlIds={query.ids} />
          <noscript>
            <p className="afl-notice compact">
              The watchlist needs JavaScript: stars are saved in this browser&apos;s local storage, which
              only scripts can read.
            </p>
          </noscript>
          <Watchlist view={watchlistView(data.levels, query)} />
        </>
      )}
    </>
  );
}

function Watchlist({ view }: { view: WatchlistView }) {
  const { query, hitters, pitchers, noLines, notFound } = view;
  const momentum = MOMENTUM_WINDOWS[DEFAULT_MOMENTUM_WINDOW];
  return (
    <>
      {query.notices.length > 0 && (
        <div className="afl-notice compact compare-notices" role="status">
          {query.notices.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}
      {(noLines.length > 0 || notFound.length > 0) && (
        <ul className="afl-notice compact compare-notices watch-missing">
          {noLines.map((e) => (
            <li key={e.id}>
              <PlayerLink player={{ id: e.id, name: e.name! }} />: no completed 2026 game line yet.{" "}
              <WatchlistStar playerId={e.id} name={e.name!} />
            </li>
          ))}
          {notFound.map((e) => (
            <li key={e.id}>
              A starred player (id {e.id.slice(0, 8)}…) is not in the loaded 2026 data.{" "}
              <WatchlistStar playerId={e.id} name={`player ${e.id.slice(0, 8)}`} />
            </li>
          ))}
        </ul>
      )}
      {hitters.length > 0 && (
        <section className="watch-section" aria-labelledby="watch-hitters">
          <h2 id="watch-hitters">Hitters</h2>
          <WatchlistTable role="hitter" entries={hitters} momentumShort={momentum.short} />
        </section>
      )}
      {pitchers.length > 0 && (
        <section className="watch-section" aria-labelledby="watch-pitchers">
          <h2 id="watch-pitchers">Pitchers</h2>
          <WatchlistTable role="pitcher" entries={pitchers} momentumShort={momentum.short} />
        </section>
      )}
      {hitters.length + pitchers.length > 0 && (
        <p className="table-note">
          Each row is the player&apos;s 2026 season line at the level of their most recent game (Lvl), with
          sample sizes (PA, BF); rows at different levels are different competitions and are not directly
          comparable. A player who also played elsewhere is listed with those levels (+), not merged.
          Momentum ({momentum.label.toLowerCase()}) compares each player&apos;s recent games with their own
          earlier games at that level; it is not a talent rating. Conf. shows how much data supports it
          (recent / earlier sample). <Link href="/data#momentum">How Momentum works</Link>
        </p>
      )}
    </>
  );
}

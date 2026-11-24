import type { Metadata } from "next";
import Link from "@/components/ui/app-link";
import { PageHeading } from "@/components/ui/primitives";
import { AflDataNotice } from "@/components/afl/data-notice";
import { LevelNav } from "@/components/levels/level-nav";
import { CompareTable } from "@/components/compare/compare-table";
import { getCompetitionData } from "@/services/competition";
import { unavailableLevels } from "@/services/competition/model";
import { compareView, type CompareView } from "@/services/compare/model";
import { COMPARE_MAX, COMPARE_MIN, compareHref, parseCompareQuery, type CompareQuery } from "@/services/compare/query";
import { levelById } from "@/services/players/levels";
import { shortDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "Compare players",
  // Every comparison is a view of one page; query variants are not crawled (src/lib/crawl-policy.ts).
  alternates: { canonical: "/compare" },
  description:
    "Compare two to four prospects side by side at one level: season line, same-level percentiles and Momentum, with sample sizes.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * `/compare?level=<id>&ids=<uuid,…>&role=<hitters|pitchers>`. Server-rendered and usable without
 * JavaScript (plain links and a GET form). Bad input shows a notice instead of a 404.
 */
export default async function ComparePage({ searchParams }: { searchParams: SearchParams }) {
  const [data, params] = await Promise.all([getCompetitionData(), searchParams]);
  const query = parseCompareQuery(params);
  return (
    <>
      <Link href="/players" className="back-link">
        ← Players
      </Link>
      <PageHeading
        title="Compare players"
        description="Two to four players side by side at one level. Statistics, percentiles and Momentum are each from that level only — levels are different competitions and are never blended."
      />
      {data.status !== "ok" ? (
        <AflDataNotice status={data.status} />
      ) : (
        <Comparison
          view={compareView(data.levels, query)}
          available={data.levels.map((l) => l.level)}
          unavailable={unavailableLevels(data.levelStatus)}
        />
      )}
    </>
  );
}

function Comparison({
  view,
  available,
  unavailable,
}: {
  view: CompareView;
  available: Parameters<typeof LevelNav>[0]["available"];
  unavailable: Parameters<typeof LevelNav>[0]["unavailable"];
}) {
  const { query } = view;
  const level = view.status === "no-level" ? null : view.level;
  const params: Record<string, string> = {};
  if (query.ids.length) params.ids = query.ids.join(",");
  if (query.role === "pitcher") params.role = "pitchers";
  return (
    <>
      {query.notices.length > 0 && (
        <div className="afl-notice compact compare-notices" role="status">
          {query.notices.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}
      <div className="compare-controls">
        <LevelNav basePath="/compare" current={level ?? ""} available={available} unavailable={unavailable} params={params} />
        <nav className="level-nav" aria-label="Hitters or pitchers">
          <span className="level-nav-label">Role</span>
          <div className="button-group">
            {(["hitter", "pitcher"] as const).map((r) => (
              <Link
                key={r}
                href={compareHref({ level, ids: query.ids, role: r })}
                className="button-link"
                aria-current={query.role === r ? "page" : undefined}
              >
                {r === "hitter" ? "Hitters" : "Pitchers"}
              </Link>
            ))}
          </div>
        </nav>
      </div>
      <Body view={view} />
      {level && <AddPlayerForm query={query} />}
    </>
  );
}

function Body({ view }: { view: CompareView }) {
  switch (view.status) {
    case "no-level":
      return (
        <div className="placeholder-panel compare-empty">
          <p>
            <strong>Choose a level to compare at.</strong> A comparison uses one level&apos;s statistics, so
            every player is measured against the same competition.
          </p>
          <Instructions withForm={false} />
        </div>
      );
    case "level-unavailable":
      return (
        <p className="afl-notice compact" role="status">
          No 2026 {levelById(view.level).label} data is loaded right now — choose another level.
        </p>
      );
    case "too-few": {
      const [only] = view.players;
      return (
        <div className="placeholder-panel compare-empty">
          <p>
            <strong>Add at least {COMPARE_MIN} players to compare.</strong>{" "}
            {only ? (
              <>
                So far: {only.name ?? "an unknown player"}
                {only.notice ? ` (${only.notice})` : ""}.
              </>
            ) : (
              "No players chosen yet."
            )}
          </p>
          <Instructions withForm />
        </div>
      );
    }
    case "ok": {
      const lvl = levelById(view.level);
      const missing = view.players.filter((p) => p.notice);
      return (
        <>
          <p className="table-note compare-meta">
            {view.seasonName}
            {view.asOf ? ` · stats through ${shortDate(view.asOf)}` : ""} · {lvl.label}{" "}
            {view.role === "hitter" ? "batting" : "pitching"} lines only
          </p>
          {missing.length > 0 && (
            <ul className="afl-notice compact compare-notices" role="status">
              {missing.map((p) => (
                <li key={p.id}>
                  {p.name ?? "Unknown player"}: {p.notice}
                </li>
              ))}
            </ul>
          )}
          <CompareTable players={view.players} groups={view.groups} level={view.level} role={view.role} />
          <p className="table-note">
            Bold marks the best value in a row where the better direction is defined (lower is better
            for ERA, WHIP, walk rate allowed and hitters&apos; strikeout rate); counting stats and
            Momentum are never marked. Sample size: {view.role === "hitter" ? "PA" : "BF"}.
            {view.percentilePopulation &&
              ` Percentiles are against ${view.percentilePopulation.size} ${view.role}s with at least ${view.percentilePopulation.minOpportunities} ${view.role === "hitter" ? "PA" : "BF"} at ${lvl.label} — not other levels or MLB.`}{" "}
            Momentum ({view.momentumWindowLabel.toLowerCase()}) compares each player&apos;s recent games
            with their own earlier {lvl.label} games; it is not a talent rating.{" "}
            <Link href="/data#momentum">How Momentum works</Link>
          </p>
        </>
      );
    }
  }
}

function Instructions({ withForm }: { withForm: boolean }) {
  return (
    <ol className="compare-steps">
      <li>
        Open a player&apos;s profile from <Link href="/players">Players</Link> and choose{" "}
        <strong>Add to compare</strong>.
      </li>
      <li>
        {withForm ? "Paste another player's profile link into the box below and choose Add" : "Then add other players by pasting their profile links"}{" "}
        (up to {COMPARE_MAX} players, all at the same level).
      </li>
    </ol>
  );
}

/** Plain GET form: works without JavaScript; the server reads the first player id in `add`. */
function AddPlayerForm({ query }: { query: CompareQuery }) {
  if (query.ids.length >= COMPARE_MAX)
    return <p className="table-note">The comparison is full ({COMPARE_MAX} players). Remove a player to add another.</p>;
  return (
    <form action="/compare" method="get" className="not-found-search compare-add">
      {query.level && <input type="hidden" name="level" value={query.level} />}
      {query.ids.length > 0 && <input type="hidden" name="ids" value={query.ids.join(",")} />}
      {query.role === "pitcher" && <input type="hidden" name="role" value="pitchers" />}
      <label htmlFor="compare-add">Add a player</label>
      <input id="compare-add" name="add" placeholder="Paste a player profile link" autoComplete="off" />
      <button type="submit">Add</button>
    </form>
  );
}

import Link from "@/components/ui/app-link";
import { DataTable, type Column } from "@/components/ui/data-table";
import { playerHref } from "@/components/ui/entity-links";
import { SIMILARITY_DIMS, SIMILARITY_DISPLAY } from "@/analytics/similarity/config";
import { formatFixed, formatPct, formatRate } from "@/services/afl/format";
import { compareHref } from "@/services/compare/query";
import type { LevelId } from "@/services/players/levels";
import type { SimilarRow, SimilarView } from "@/services/players/similar";

const GROUP_LABEL: Record<string, string> = { C: "catchers", IF: "infielders", OF: "outfielders" };
const ROLE_LABEL = { hitter: "Hitting", pitcher: "Pitching" } as const;

/** Observed rate in the dimension's usual notation: percentages for per-PA/BF rates, .xxx for ISO-style rates. */
function rate(key: string, x: number) {
  if (key === "k" || key === "bb" || key === "hr") return formatPct(x * 100);
  if (key === "bfApp") return formatFixed(x, 1);
  return formatRate(x);
}

type Row = SimilarRow & { self?: boolean };

/**
 * "Similar so far this season" (D-028): a browsing aid, not a projection (D-025, D-027). Same level and role; hitters
 * within their position group (D-026).
 */
export function SimilarPlayers({ views, level, playerId }: { views: SimilarView[]; level: LevelId; playerId: string }) {
  return (
    <>
      <p className="table-note">
        Players at this level whose season-to-date profile (strikeout, walk and batted-ball rates, speed or usage, and
        age vs level) is closest to this player&apos;s; hitters are compared only within their position group. A
        browsing aid, not a projection: similar players did not predict later performance in validation. Scores
        below {SIMILARITY_DISPLAY.scoreFloor} are not listed. Rates shown are observed; the comparison uses rates
        adjusted for sample size. <Link href="/data#similarity">Method</Link>
      </p>
      {views.map((v) => (
        <div key={v.role}>
          {views.length > 1 && <h3 className="table-title">{ROLE_LABEL[v.role]}</h3>}
          <SimilarRole view={v} level={level} playerId={playerId} />
        </div>
      ))}
    </>
  );
}

function SimilarRole({ view, level, playerId }: { view: SimilarView; level: LevelId; playerId: string }) {
  const unit = view.role === "hitter" ? "PA" : "BF";
  if (view.status !== "ok") {
    const message = {
      "not-offered": "Similar players are not offered for the Fall League (samples are too small).",
      "not-enough-data": `Not enough data for similar players yet (needs 100 ${unit} at this level).`,
      "small-group": "Not enough similar players: too few qualified hitters at this position at this level.",
      "no-close-match": "No close match at this level.",
    }[view.status];
    return <p className="empty-state">{message}</p>;
  }
  const dims = SIMILARITY_DIMS[view.role];
  const columns: Column<Row>[] = [
    {
      key: "player",
      label: "Player",
      render: (r) => (r.self ? <strong>{r.name}</strong> : <Link className="player-name" href={playerHref(r.id, level)}>{r.name}</Link>),
    },
    { key: "pos", label: "Pos", render: (r) => r.position },
    { key: "hand", label: view.role === "hitter" ? "Bats" : "Throws", render: (r) => r.hand ?? "—" },
    {
      key: "n",
      label: unit,
      numeric: true,
      render: (r) => (
        <>
          {r.sample}
          {r.sampleGap && <span title={`Sample differs from this player's by ${SIMILARITY_DISPLAY.sampleGapFactor}× or more`}> †</span>}
        </>
      ),
    },
    { key: "score", label: "Score", title: "100 = identical profile; 61 ≈ one standard deviation apart on average", numeric: true, render: (r) => (r.self ? "—" : r.score) },
    ...dims.map((d, j): Column<Row> => ({ key: d.key, label: d.label, numeric: true, render: (r) => rate(d.key, r.rates[j]) })),
    { key: "closest", label: "Closest on", render: (r) => (r.self ? "" : r.closest.join(", ")) },
    { key: "furthest", label: "Furthest on", render: (r) => (r.self ? "" : r.furthest.join(", ")) },
    {
      key: "compare",
      label: "Compare",
      render: (r) => (r.self ? "" : <Link href={compareHref({ level, ids: [playerId, r.id], role: view.role })}>Compare</Link>),
    },
  ];
  const rows: Row[] = [{ ...view.self, score: 0, closest: [], furthest: [], sampleGap: false, self: true }, ...view.rows];
  const group = view.group ? GROUP_LABEL[view.group] ?? view.group : null;
  return (
    <>
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        caption={`${ROLE_LABEL[view.role]}: similar ${group ?? `${view.role}s`} so far this season`}
      />
      {view.rows.some((r) => r.sampleGap) && (
        <p className="table-note">† Sample size differs from this player&apos;s by {SIMILARITY_DISPLAY.sampleGapFactor}× or more.</p>
      )}
    </>
  );
}

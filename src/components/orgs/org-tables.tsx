import Link from "@/components/ui/app-link";
import { DataTable, type Column } from "@/components/ui/data-table";
import { PlayerLink } from "@/components/ui/entity-links";
import { MomentumValue } from "@/components/analytics/momentum-parts";
import { formatFixed, formatPct, formatRate, inningsFromOuts } from "@/services/afl/format";
import type { PlayerDirectoryRow } from "@/services/players/directory";
import { levelById, type LevelId } from "@/services/players/levels";
import type { OrgAffiliate, OrgLevelGroup } from "@/services/orgs/model";

const num = (key: string, label: string, get: (r: PlayerDirectoryRow) => number | string | null, title?: string): Column<PlayerDirectoryRow> => ({
  key,
  label,
  title,
  numeric: true,
  render: (r) => get(r) ?? "—",
});

const context = (level: LevelId): Column<PlayerDirectoryRow>[] => [
  { key: "player", label: "Player", render: (r) => <PlayerLink player={r} level={level} /> },
  { key: "pos", label: "Pos", render: (r) => r.position },
  { key: "age", label: "Age", numeric: true, render: (r) => r.age ?? "—" },
];

const momentum = (role: "hitter" | "pitcher", short: string): Column<PlayerDirectoryRow> => ({
  key: "mom",
  label: `Mom. ${short}`,
  title: `Momentum (${short}): recent games vs. the player's own earlier games at this level, −100 to +100. Not a quality grade.`,
  numeric: true,
  render: (r) => <MomentumValue score={r.momentum[role]?.score ?? null} />,
});

function hitterColumns(level: LevelId, short: string): Column<PlayerDirectoryRow>[] {
  const b = (r: PlayerDirectoryRow) => r.batting!;
  return [
    ...context(level),
    num("g", "G", (r) => b(r).gameLines, "Games with a batting line"),
    num("pa", "PA", (r) => b(r).plateAppearances, "Plate appearances (sample size)"),
    num("avg", "AVG", (r) => formatRate(b(r).avg)),
    num("obp", "OBP", (r) => formatRate(b(r).obp)),
    num("slg", "SLG", (r) => formatRate(b(r).slg)),
    num("ops", "OPS", (r) => formatRate(b(r).ops)),
    num("hr", "HR", (r) => b(r).homeRuns),
    num("sb", "SB", (r) => b(r).stolenBases),
    num("bbp", "BB%", (r) => formatPct(b(r).bbPct)),
    num("kp", "K%", (r) => formatPct(b(r).kPct)),
    momentum("hitter", short),
  ];
}

function pitcherColumns(level: LevelId, short: string): Column<PlayerDirectoryRow>[] {
  const p = (r: PlayerDirectoryRow) => r.pitching!;
  return [
    ...context(level),
    num("g", "G", (r) => p(r).gameLines, "Games with a pitching line"),
    num("ip", "IP", (r) => inningsFromOuts(p(r).outsRecorded)),
    num("bf", "BF", (r) => p(r).battersFaced, "Batters faced (sample size)"),
    num("era", "ERA", (r) => formatFixed(p(r).era, 2)),
    num("whip", "WHIP", (r) => formatFixed(p(r).whip, 2)),
    num("kp", "K%", (r) => formatPct(p(r).kPct)),
    num("bbp", "BB%", (r) => formatPct(p(r).bbPct)),
    num("hr", "HR", (r) => p(r).homeRunsAllowed, "Home runs allowed"),
    momentum("pitcher", short),
  ];
}

function Affiliate({ level, affiliate, momentumShort }: { level: LevelId; affiliate: OrgAffiliate; momentumShort: string }) {
  const team = affiliate.team;
  const name = team?.name ?? "Team not recorded";
  return (
    <section className="org-affiliate" id={team ? `team-${team.id}` : undefined} aria-labelledby={team ? `team-${team.id}-h` : undefined}>
      <div className="section-heading">
        <h3 id={team ? `team-${team.id}-h` : undefined}>
          {name} <span className="small-muted">{levelById(level).label}</span>
        </h3>
        {team && (
          <Link href={`/players?level=${level}&team=${team.id}`} title={`${team.name} in the player directory`}>
            Sort and filter in Players →
          </Link>
        )}
      </div>
      {affiliate.hitters.length > 0 && (
        <DataTable
          rows={affiliate.hitters}
          columns={hitterColumns(level, momentumShort)}
          rowKey={(r) => r.id}
          caption={`${name} hitters: ${levelById(level).label} season batting line and Momentum`}
        />
      )}
      {affiliate.pitchers.length > 0 && (
        <DataTable
          rows={affiliate.pitchers}
          columns={pitcherColumns(level, momentumShort)}
          rowKey={(r) => r.id}
          caption={`${name} pitchers: ${levelById(level).label} season pitching line and Momentum`}
        />
      )}
    </section>
  );
}

export function OrgLevels({ groups, momentumShort }: { groups: OrgLevelGroup[]; momentumShort: string }) {
  return (
    <>
      {groups.map((g) => (
        <section key={g.level} className="org-level" aria-labelledby={`level-${g.level}`}>
          <h2 id={`level-${g.level}`}>{levelById(g.level).label}</h2>
          {g.affiliates.map((a) => (
            <Affiliate key={a.team?.id ?? "none"} level={g.level} affiliate={a} momentumShort={momentumShort} />
          ))}
        </section>
      ))}
    </>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { prospectRepository } from "@/services/prospects";
import { SectionTitle, Grade, Momentum } from "@/components/ui/primitives";
import {
  OrganizationLink,
  TeamLink,
  ContextLink,
} from "@/components/ui/entity-links";
import { DataTable } from "@/components/ui/data-table";
import { StatTable, type StatRow } from "@/components/data/stat-table";
import { ScoreChart } from "@/components/market/score-chart";
import { NewsList } from "@/components/market/news-list";
import { ageOn } from "@/lib/format";
import { DEMO_AS_OF } from "@/data/demo";
import { windowLabels } from "@/services/discovery";
import type { TimeWindow } from "@/types/baseball";
export async function generateStaticParams() {
  return (await prospectRepository.listPlayers()).map((p) => ({ id: p.id }));
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const p = await prospectRepository.findPlayer((await params).id);
  return { title: p ? `${p.name} — Player profile` : "Player not found" };
}
export default async function PlayerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const catalog = await prospectRepository.catalog();
  const player = catalog.players.find((p) => p.id === id);
  if (!player) notFound();
  const team = catalog.teams.find((t) => t.id === player.teamId)!;
  const context = catalog.contexts.find((c) => c.id === team.contextId)!;
  const organization = catalog.organizations.find(
    (o) => o.id === player.organizationId,
  )!;
  const history = catalog.memberships
    .filter((m) => m.playerId === id)
    .sort((a, b) => b.startsOn.localeCompare(a.startsOn));
  const recent: StatRow[] = (
    ["7d", "14d", "30d", "season"] as TimeWindow[]
  ).map((w) => ({
    id: w,
    label: windowLabels[w],
    teamId: team.id,
    ...player.performance[w],
  }));
  const seasons: StatRow[] = player.seasonStats.map((s) => ({
    id: `${s.season}-${s.teamId}`,
    label: `${s.season} team stint`,
    ...s,
  }));
  return (
    <>
      <Link href="/players" className="back-link">
        ← Player directory
      </Link>
      <header className="player-header">
        <p className="eyebrow">Fictional player profile</p>
        <h1>{player.name}</h1>
        <div className="context-line">
          <OrganizationLink organization={organization} full />
          <TeamLink team={team} full />
          <ContextLink context={context} />
          <span>{player.position}</span>
          <span>Age {ageOn(player.birthDate, DEMO_AS_OF)}</span>
          <span>
            Bats {player.bats} / Throws {player.throws}
          </span>
        </div>
        <div className="profile-scores">
          <span>
            Prospect Grade{" "}
            <strong>
              <Grade value={player.grade} />
            </strong>{" "}
            / 100
          </span>
          <span>
            Momentum{" "}
            <strong>
              <Momentum value={player.momentum} />
            </strong>
          </span>
          <span className="small-muted">
            Illustrative snapshot · {DEMO_AS_OF}
          </span>
        </div>
      </header>
      <nav className="profile-tabs" aria-label="Player sections">
        {["Overview", "Stats", "Development", "Trends", "News"].map((tab) => (
          <a key={tab} href={`#${tab.toLowerCase()}`}>
            {tab}
          </a>
        ))}
        <span title="No game-level demo records available">
          Game log · planned
        </span>
        <span title="No splits or ranking records available">
          Splits / rankings · planned
        </span>
      </nav>
      <section id="overview" className="page-section">
        <SectionTitle title="Why is this player interesting?" />
        <p className="watch-note">{player.note}</p>
        <p className="table-note">
          Explanation preview only. No automated cause attribution, performance
          weighting, or scouting grades have been implemented. Read the actual
          fictional counting stats below.
        </p>
      </section>
      <section id="stats" className="page-section">
        <SectionTitle
          title="Recent performance"
          action={<Link href="/data">Compare in Data →</Link>}
        />
        <p className="table-note">
          Current playing context: <TeamLink team={team} full /> · demo windows
          ending {DEMO_AS_OF}. Season is the current stint, never a blend of
          affiliated and fall-league statistics.
        </p>
        {player.batting && (
          <>
            <h3 className="table-title">Batting</h3>
            <StatTable rows={recent} catalog={catalog} type="batting" />
          </>
        )}
        {player.pitching && (
          <>
            <h3 className="table-title">Pitching</h3>
            <StatTable rows={recent} catalog={catalog} type="pitching" />
          </>
        )}
        <h3 className="table-title">Season history by team</h3>
        {player.batting && (
          <StatTable rows={seasons} catalog={catalog} type="batting" />
        )}
        {player.pitching && (
          <StatTable rows={seasons} catalog={catalog} type="pitching" />
        )}
        <p className="table-note">
          Only documented fixture stints have statistical rows. Earlier
          assignment dates do not imply that historical statistics or game logs
          are available.
        </p>
      </section>
      <section id="development" className="page-section">
        <SectionTitle title="Development timeline" />
        <p className="table-note">
          Parent organization:{" "}
          <OrganizationLink organization={organization} full />. Organization
          membership is independent of team assignments. An open affiliated
          membership may coexist with an AFL assignment.
        </p>
        <DataTable
          rows={history}
          rowKey={(m) => m.id}
          caption="Fictional player assignment and promotion timeline"
          columns={[
            {
              key: "date",
              label: "From",
              render: (m) => <time dateTime={m.startsOn}>{m.startsOn}</time>,
            },
            {
              key: "until",
              label: "Through",
              render: (m) => m.endsOn ?? "Open affiliation",
            },
            {
              key: "event",
              label: "Movement",
              render: (m) =>
                m.assignmentType === "afl-assignment"
                  ? "AFL assignment"
                  : m.assignmentType === "promotion"
                    ? "Promotion"
                    : "Assignment",
            },
            {
              key: "team",
              label: "Team",
              render: (m) => (
                <TeamLink
                  team={catalog.teams.find((t) => t.id === m.teamId)!}
                  full
                />
              ),
            },
            {
              key: "context",
              label: "Level / league",
              render: (m) => (
                <ContextLink
                  context={catalog.contexts.find(
                    (c) =>
                      c.id ===
                      catalog.teams.find((t) => t.id === m.teamId)!.contextId,
                  )!}
                />
              ),
            },
          ]}
        />
      </section>
      <section id="trends" className="page-section">
        <SectionTitle title="Development trajectory" />
        <ScoreChart observations={player.history} />
      </section>
      <section id="news" className="page-section">
        <SectionTitle title="Player news" />
        <NewsList
          items={catalog.news.filter((n) => n.playerIds.includes(id))}
          catalog={catalog}
        />
      </section>
    </>
  );
}

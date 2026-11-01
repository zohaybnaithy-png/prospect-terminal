import Link from "next/link";
import { prospectRepository } from "@/services/prospects";
import { discoverDemoPlayers, defaultFilters } from "@/services/discovery";
import { PerformanceExplorer } from "@/components/discovery/performance-explorer";
import { SectionTitle, Momentum } from "@/components/ui/primitives";
import {
  PlayerLink,
  TeamLink,
  ContextLink,
} from "@/components/ui/entity-links";
import { NewsList } from "./news-list";
import { shortDate } from "@/lib/format";
export async function MarketDashboard() {
  const catalog = await prospectRepository.catalog();
  const risers = [...catalog.players]
    .sort((a, b) => b.momentum - a.momentum)
    .slice(0, 4);
  const afl = discoverDemoPlayers(catalog, {
    ...defaultFilters,
    context: "afl",
    ranking: "performance",
    window: "7d",
  });
  const events = catalog.memberships
    .filter((m) => m.assignmentType !== "assignment")
    .sort((a, b) => b.startsOn.localeCompare(a.startsOn))
    .slice(0, 4);
  return (
    <>
      <div className="home-heading">
        <div>
          <h1>Minor league discovery</h1>
          <p>
            Recent performers, development movement, and players worth a closer
            look.
          </p>
        </div>
        <Link href="/data">Full statistical leaderboards →</Link>
      </div>
      <PerformanceExplorer catalog={catalog} />
      <div className="home-columns">
        <section>
          <SectionTitle
            title="Biggest demo risers"
            action={<Link href="/screener">Open screener →</Link>}
          />
          <p className="small-muted">
            Illustrative Momentum, not a calculated ranking.
          </p>
          <ol className="compact-player-list">
            {risers.map((p) => (
              <li key={p.id}>
                <PlayerLink player={p} />
                <ContextLink
                  context={catalog.contexts.find(
                    (c) =>
                      c.id ===
                      catalog.teams.find((t) => t.id === p.teamId)!.contextId,
                  )!}
                />
                <Momentum value={p.momentum} />
              </li>
            ))}
          </ol>
        </section>
        <section>
          <SectionTitle
            title="Arizona Fall League"
            action={<Link href="/leagues/afl">AFL performers →</Link>}
          />
          <p className="small-muted">
            Pure Performance · 7D · fictional fall assignments
          </p>
          <ol className="compact-player-list">
            {afl.map((p) => (
              <li key={p.id}>
                <PlayerLink player={p} />
                <TeamLink
                  team={catalog.teams.find((t) => t.id === p.teamId)!}
                />
                <span>{p.position}</span>
              </li>
            ))}
          </ol>
        </section>
        <section>
          <SectionTitle title="Development wire" />
          <ul className="transaction-list">
            {events.map((m) => {
              const p = catalog.players.find((p) => p.id === m.playerId)!;
              const t = catalog.teams.find((t) => t.id === m.teamId)!;
              return (
                <li key={m.id}>
                  <time dateTime={m.startsOn}>{shortDate(m.startsOn)}</time>
                  <div>
                    <PlayerLink player={p} />
                    <p>
                      {m.assignmentType === "afl-assignment"
                        ? "Fall assignment"
                        : "Promotion"}{" "}
                      · <TeamLink team={t} full />
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
      <section className="news-section">
        <SectionTitle
          title="Latest prospect news"
          action={<Link href="/news">All news →</Link>}
        />
        <NewsList items={catalog.news.slice(0, 3)} catalog={catalog} />
      </section>
      <p className="about-note">
        <strong>About Prospect Terminal.</strong> A player-first home for
        discovering who is performing, following development, and exploring the
        context behind the numbers. This preview uses fictional data; legitimate
        MiLB/AFL data research comes next.
      </p>
    </>
  );
}

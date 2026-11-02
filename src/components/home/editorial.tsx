import Link from "next/link";
import Image from "next/image";
import { Play } from "lucide-react";
import type { Catalog, NewsItem } from "@/types/baseball";
import type { DemoHighlight } from "@/data/demo-home";
import {
  PlayerLink,
  TeamLink,
  OrganizationLink,
} from "@/components/ui/entity-links";
import { shortDate } from "@/lib/format";
export function HeadlineCard({
  story,
  image,
  alt,
  teaser,
  catalog,
}: {
  story: NewsItem;
  image: string;
  alt: string;
  teaser: string;
  catalog: Catalog;
}) {
  const player = catalog.players.find((p) => p.id === story.playerIds[0]);
  return (
    <article className="headline-card">
      <Link href={`/news#${story.id}`} className="editorial-image">
        <Image src={image} alt={alt} width={900} height={420} preload />
        <span className="image-caption">{story.category} · Demo story</span>
      </Link>
      <h3>
        <Link href={`/news#${story.id}`}>{story.title}</Link>
      </h3>
      <p>{teaser}</p>
      <div className="headline-meta">
        {player && <PlayerLink player={player} />}
        <time dateTime={story.date}>{shortDate(story.date)}</time>
      </div>
    </article>
  );
}
export function HighlightCard({
  highlight,
  catalog,
}: {
  highlight: DemoHighlight;
  catalog: Catalog;
}) {
  const player = catalog.players.find((p) => p.id === highlight.playerId)!;
  const team = catalog.teams.find((t) => t.id === player.teamId)!;
  return (
    <article className="highlight-card">
      <Link
        href={`/highlights#${highlight.id}`}
        className="highlight-image"
        aria-label={`Preview: ${highlight.title} — demo illustration, no video`}
      >
        <Image
          src={highlight.image}
          alt={highlight.alt}
          width={900}
          height={420}
        />
        <span className="preview-indicator">
          <Play size={15} fill="currentColor" aria-hidden="true" /> Demo preview
        </span>
      </Link>
      <h3>
        <Link href={`/highlights#${highlight.id}`}>{highlight.title}</Link>
      </h3>
      <div className="highlight-meta">
        <PlayerLink player={player} />
        <TeamLink team={team} />
      </div>
    </article>
  );
}
export function TopProspects({ catalog }: { catalog: Catalog }) {
  const players = [...catalog.players]
    .sort((a, b) => b.grade - a.grade)
    .slice(0, 5);
  return (
    <section className="top-prospects" aria-labelledby="top-prospects-title">
      <div className="home-section-heading">
        <h2 id="top-prospects-title">Top Prospects</h2>
        <span>Demo Grade</span>
      </div>
      <ol className="top-prospect-list">
        {players.map((p, i) => (
          <li key={p.id}>
            <span className="list-rank">{i + 1}</span>
            <PlayerLink player={p} />
            <OrganizationLink
              organization={
                catalog.organizations.find((o) => o.id === p.organizationId)!
              }
            />
            <strong>{p.grade}</strong>
          </li>
        ))}
      </ol>
      <div className="widget-bottom">
        <Link href="/players">All prospects →</Link>
        <span>Fictional placeholder · no Grade model yet</span>
      </div>
    </section>
  );
}
export function RecentCallups({ catalog }: { catalog: Catalog }) {
  const events = catalog.memberships
    .filter((m) => m.assignmentType === "promotion")
    .sort((a, b) => b.startsOn.localeCompare(a.startsOn))
    .slice(0, 2);
  return (
    <section className="recent-callups" aria-labelledby="callups-title">
      <div className="home-section-heading">
        <h2 id="callups-title">Recent Call-Ups</h2>
        <Link href="/players">Development timelines →</Link>
      </div>
      <ul className="callup-list">
        {events.map((event) => {
          const player = catalog.players.find((p) => p.id === event.playerId)!;
          const prior = catalog.memberships
            .filter(
              (m) => m.playerId === player.id && m.startsOn < event.startsOn,
            )
            .sort((a, b) => b.startsOn.localeCompare(a.startsOn))[0];
          const from = catalog.teams.find((t) => t.id === prior?.teamId);
          const to = catalog.teams.find((t) => t.id === event.teamId)!;
          return (
            <li key={event.id}>
              <div>
                <PlayerLink player={player} />
                <OrganizationLink
                  organization={
                    catalog.organizations.find(
                      (o) => o.id === player.organizationId,
                    )!
                  }
                />
              </div>
              <span>
                {from
                  ? catalog.contexts.find((c) => c.id === from.contextId)
                      ?.shortName
                  : "—"}{" "}
                →{" "}
                {catalog.contexts.find((c) => c.id === to.contextId)?.shortName}
              </span>
              <time dateTime={event.startsOn}>{shortDate(event.startsOn)}</time>
            </li>
          );
        })}
      </ul>
      <p className="home-fine-print">
        Fictional affiliate promotions · latest recorded demo movements.
      </p>
    </section>
  );
}

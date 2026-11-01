import Link from "next/link";
import type { NewsItem, Catalog } from "@/types/baseball";
import {
  PlayerLink,
  TeamLink,
  OrganizationLink,
} from "@/components/ui/entity-links";
import { shortDate } from "@/lib/format";
export function NewsList({
  items,
  catalog,
}: {
  items: NewsItem[];
  catalog: Catalog;
}) {
  return (
    <div className="news-list">
      {items.length ? (
        items.map((item) => (
          <article id={item.id} key={item.id} className="news-item">
            <div className="news-dateline">
              <time dateTime={item.date}>
                {shortDate(item.date)}, {item.date.slice(0, 4)}
              </time>
              <span>{item.category}</span>
              <small>FICTIONAL STORY</small>
            </div>
            <div>
              <h3>
                <Link href={`/news#${item.id}`}>{item.title}</Link>
              </h3>
              <p>{item.summary}</p>
              <div className="entity-links">
                {item.playerIds.map((id) => {
                  const p = catalog.players.find((p) => p.id === id);
                  return p && <PlayerLink key={id} player={p} />;
                })}
                {item.teamIds.map((id) => {
                  const t = catalog.teams.find((t) => t.id === id);
                  return t && <TeamLink key={id} team={t} full />;
                })}
                {item.organizationIds.map((id) => {
                  const o = catalog.organizations.find((o) => o.id === id);
                  return (
                    o && <OrganizationLink key={id} organization={o} full />
                  );
                })}
              </div>
            </div>
          </article>
        ))
      ) : (
        <p className="empty-state">No demo stories for this selection.</p>
      )}
    </div>
  );
}

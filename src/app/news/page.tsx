import Link from "next/link";
import type { Metadata } from "next";
import { PageHeading } from "@/components/ui/primitives";
import { prospectRepository } from "@/services/prospects";
import { shortDate } from "@/lib/format";
export const metadata: Metadata = { title: "News" };
export default async function NewsPage() {
  const [news, players] = await Promise.all([
    prospectRepository.listNews(),
    prospectRepository.listPlayers(),
  ]);
  return (
    <>
      <PageHeading
        title="The intelligence feed"
        description="Fictional development stories. Real news sourcing and highlights are planned for a later phase."
      />
      <div className="news-feed">
        {news.map((item) => (
          <article id={item.id} key={item.id} className="panel news-article">
            <div className="news-meta">
              <span>{item.category}</span>
              <span>FICTIONAL DEMO CONTENT</span>
            </div>
            <h2>{item.title}</h2>
            <time dateTime={item.date}>
              {shortDate(item.date)}, 2026 · Prospect Terminal Demo Desk
            </time>
            <p>{item.summary}</p>
            <div className="related-players">
              {item.playerIds.map((id) => (
                <Link key={id} href={`/players/${id}`}>
                  {players.find((p) => p.id === id)?.name} ↗
                </Link>
              ))}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

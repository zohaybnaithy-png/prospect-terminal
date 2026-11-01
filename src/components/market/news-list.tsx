import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { NewsItem } from "@/types/baseball";
import { shortDate } from "@/lib/format";
export function NewsList({ items }: { items: NewsItem[] }) {
  return (
    <div className="news-list">
      {items.map((item, i) => (
        <article key={item.id} className="news-item">
          <div className="news-number">0{i + 1}</div>
          <div>
            <div className="news-meta">
              <span>{item.category}</span>
              <span>DEMO STORY</span>
            </div>
            <h3>
              <Link href={`/news#${item.id}`}>{item.title}</Link>
            </h3>
            <p>{item.summary}</p>
            <time dateTime={item.date}>{shortDate(item.date)}, 2026</time>
          </div>
          <ArrowUpRight size={17} className="muted" aria-hidden="true" />
        </article>
      ))}
    </div>
  );
}

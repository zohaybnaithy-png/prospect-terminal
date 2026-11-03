import Link from "next/link";
import { Suspense } from "react";
import { prospectRepository } from "@/services/prospects";
import { homeHeadlines, demoHighlights } from "@/data/demo-home";
import { DEMO_AS_OF } from "@/data/demo";
import {
  HeadlineCard,
  HighlightCard,
  TopProspects,
  RecentCallups,
} from "@/components/home/editorial";
import {
  AflRecentPerformersFallback,
  AflRecentPerformersSection,
} from "@/components/afl/home-performers";
import { NewsList } from "./news-list";
export async function MarketDashboard() {
  const catalog = await prospectRepository.catalog();
  return (
    <>
      <h1 className="sr-only">
        Prospect Terminal: prospect performance, development, news and
        highlights
      </h1>
      <div className="homepage-grid">
        <div className="homepage-editorial">
          <section aria-labelledby="latest-title" className="latest-headlines">
            <div className="home-section-heading">
              <h2 id="latest-title">Latest Prospect News</h2>
              <Link href="/news">All news →</Link>
            </div>
            <div className="headline-grid">
              {homeHeadlines.map((item) => (
                <HeadlineCard
                  key={item.newsId}
                  {...item}
                  story={catalog.news.find((n) => n.id === item.newsId)!}
                  catalog={catalog}
                />
              ))}
            </div>
          </section>
          <section
            aria-labelledby="highlights-title"
            className="recent-highlights"
          >
            <div className="home-section-heading">
              <h2 id="highlights-title">Recent Highlights</h2>
              <Link href="/highlights">All previews →</Link>
            </div>
            <div className="highlight-grid">
              {demoHighlights.map((highlight) => (
                <HighlightCard
                  key={highlight.id}
                  highlight={highlight}
                  catalog={catalog}
                />
              ))}
            </div>
          </section>
          <RecentCallups catalog={catalog} />
        </div>
        <aside className="homepage-sidebar" aria-label="Prospect intelligence">
          <Suspense fallback={<AflRecentPerformersFallback />}>
            <AflRecentPerformersSection />
          </Suspense>
          <TopProspects catalog={catalog} />
          <p className="home-fine-print">
            AFL Recent Performers and the score strip use real 2026 Arizona Fall
            League game data (MLB Stats API, development use). News, highlights,
            call-ups and Top Prospects Grades are fictional demo placeholders
            (snapshot {DEMO_AS_OF}); no Prospect Grade model exists yet, and
            AFL Momentum (Trends, player profiles) is a provisional model under
            review.
          </p>
        </aside>
      </div>
      <section className="home-more">
        <div className="home-section-heading">
          <h2>More from the Minors</h2>
          <Link href="/leagues/afl">Explore the Arizona Fall League →</Link>
        </div>
        <NewsList items={catalog.news.slice(2)} catalog={catalog} />
      </section>
    </>
  );
}

import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  TrendingUp,
  TrendingDown,
  Zap,
  Crosshair,
  ChevronRight,
} from "lucide-react";
import { getMarketOverview, prospectRepository } from "@/services/prospects";
import { SectionTitle, Momentum } from "@/components/ui/primitives";
import { PlayerTable } from "./player-table";
import { Spotlight } from "./spotlight";
import { NewsList } from "./news-list";
export async function MarketDashboard() {
  const [{ top, rising, falling }, teams, news] = await Promise.all([
    getMarketOverview(),
    prospectRepository.listTeams(),
    prospectRepository.listNews(),
  ]);
  const spotlight = top[0];
  const cards = [
    {
      label: "Top Prospects",
      tag: "THE LEADERS",
      Icon: Crosshair,
      player: top[0],
      value: String(top[0].grade),
      unit: "GRADE",
      href: "/players?sort=grade",
      color: "mint",
      caption: "Highest illustrative prospect grade",
    },
    {
      label: "Trending Up",
      tag: "POSITIVE MOVEMENT",
      Icon: TrendingUp,
      player: rising[0],
      value: `+${rising[0].momentum.toFixed(1)}`,
      unit: "MOMENTUM",
      href: "/players?sort=momentum",
      color: "mint",
      caption: `${rising.length} demo players with positive momentum`,
    },
    {
      label: "Trending Down",
      tag: "NEGATIVE MOVEMENT",
      Icon: TrendingDown,
      player: falling[0],
      value: falling[0].momentum.toFixed(1),
      unit: "MOMENTUM",
      href: "/players?sort=falling",
      color: "coral",
      caption: `${falling.length} demo players with negative momentum`,
    },
    {
      label: "Breakouts",
      tag: "ON THE RADAR",
      Icon: Zap,
      player: rising[1],
      value: `+${rising[1].momentum.toFixed(1)}`,
      unit: "MOMENTUM",
      href: `/players/${rising[1].id}`,
      color: "amber",
      caption: "Editorial demo selection · no model yet",
    },
  ];
  return (
    <>
      <div className="market-topline">
        <span>THE COLLEGE PROSPECT MARKET</span>
        <span>
          <span className="status-dot" /> DEMO SNAPSHOT{" "}
          <span className="topline-date">APR 18, 2026</span>
        </span>
      </div>
      <section className="hero">
        <div>
          <div className="hero-kicker">
            <span /> BASEBALL’S NEXT GENERATION
          </div>
          <h1>
            See the game.
            <br />
            <span>Find the next wave.</span>
          </h1>
          <p>
            A clearer view of tomorrow’s talent. Track prospects,
            <br className="desktop-break" /> follow the movement, and look
            beyond the box score.
          </p>
          <Link className="primary-link" href="/players">
            Explore prospects <ArrowUpRight size={16} />
          </Link>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="radar-grid" />
          <div className="radar-diamond diamond-outer" />
          <div className="radar-diamond diamond-inner" />
          <div className="radar-line" />
          <span className="radar-node node-one" />
          <span className="radar-node node-two" />
          <span className="radar-node node-three" />
          <div className="radar-label label-one">
            SCOUT THE SIGNAL<span>35.042° N / 89.982° W</span>
          </div>
          <div className="radar-label label-two">
            THE FUTURE IS IN PLAY <ArrowUpRight size={12} />
          </div>
          <span className="radar-plus plus-one">+</span>
          <span className="radar-plus plus-two">+</span>
        </div>
      </section>
      <section className="overview-section">
        <SectionTitle
          title="Market overview"
          action={
            <span className="section-note">
              NCAA DIVISION I <span> / </span> FICTIONAL DATA
            </span>
          }
        />
        <div className="overview-grid">
          {cards.map(
            ({
              label,
              tag,
              Icon,
              player,
              value,
              unit,
              href,
              color,
              caption,
            }) => (
              <Link
                href={href}
                className={`overview-card ${color}`}
                key={label}
              >
                <div className="card-top">
                  <span>
                    <Icon size={16} />
                    {label}
                  </span>
                  <ArrowUpRight size={16} />
                </div>
                <div className="card-value">
                  {value}
                  <span>{unit}</span>
                </div>
                <div className="card-player">
                  {player.name}
                  <span>{tag}</span>
                </div>
                <p>{caption}</p>
              </Link>
            ),
          )}
        </div>
      </section>
      <div className="dashboard-grid">
        <section className="panel trending-panel">
          <div className="panel-heading">
            <SectionTitle
              eyebrow="FOLLOW THE MOVEMENT"
              title="Trending players"
              action={
                <Link className="text-link" href="/players">
                  All players <ArrowRight size={14} />
                </Link>
              }
            />
            <div className="table-subtitle">
              <span className="tiny-label">MOMENTUM LEADERS</span>
              <span>
                {rising.length} RISING <span className="muted">/</span>{" "}
                {falling.length} FALLING
              </span>
            </div>
          </div>
          <PlayerTable players={rising.slice(0, 7)} teams={teams} />
          <div className="panel-bottom">
            <span>All scores and statistics are illustrative.</span>
            <Link href="/screener">
              Open screener <ChevronRight size={13} />
            </Link>
          </div>
        </section>
        <section className="panel spotlight-panel">
          <div className="panel-heading">
            <SectionTitle
              eyebrow="ONE TO WATCH"
              title="Prospect spotlight"
              action={<span className="pill">DEMO</span>}
            />
          </div>
          <Spotlight
            player={spotlight}
            team={teams.find((t) => t.id === spotlight.teamId)!}
          />
        </section>
      </div>
      <section className="news-section">
        <SectionTitle
          eyebrow="FROM AROUND THE DIAMOND"
          title="The latest intelligence"
          action={
            <Link className="text-link" href="/news">
              All news <ArrowRight size={14} />
            </Link>
          }
        />
        <NewsList items={news} />
      </section>
      <div className="foundation-note">
        <span className="note-symbol">PT / 01</span>
        <p>
          <strong>A foundation for better prospect intelligence.</strong> This
          is an early development preview. Real data, rankings, and analytics
          are on the roadmap.
        </p>
        <Momentum value={8.4} />
      </div>
    </>
  );
}

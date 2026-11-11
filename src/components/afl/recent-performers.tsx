"use client";
import { SourceTag } from "@/components/home/source-tag";
import Link from "@/components/ui/app-link";
import { useState } from "react";
import type { RecentPerformer } from "@/services/afl/read-model";
import { PlayerLink } from "@/components/ui/entity-links";
import { AflOrganizationLink, AflTeamLink } from "./links";
import type { LevelId } from "@/services/players/levels";

type Window = "7d" | "14d" | "30d";
type Role = "hitters" | "pitchers";
export type RecentPerformerSets = Record<
  Window,
  Record<Role, RecentPerformer[]>
>;

/**
 * Real game-log samples for one level sorted by one raw statistic (OPS for qualified hitters, strikeouts for
 * pitchers). This is a descriptive leaderboard, not a trend, Momentum, or prospect-ranking model.
 */
export function AflRecentPerformers({
  sets,
  minPa,
  asOf,
  level,
}: {
  sets: RecentPerformerSets;
  minPa: Record<Window, number>;
  asOf: string;
  level: LevelId;
}) {
  const [window, setWindow] = useState<Window>("14d");
  const [role, setRole] = useState<Role>("hitters");
  const players = sets[window][role];
  return (
    <section className="home-panel" aria-labelledby="performers-title">
      <div className="home-section-heading">
        <h2 id="performers-title">
          Recent Leaders <SourceTag kind="live" />
        </h2>
      </div>
      <div className="panel-controls">
        <div
          className="button-group"
          role="group"
          aria-label="Performance timeframe"
        >
          {(["7d", "14d", "30d"] as const).map((w) => (
            <button
              key={w}
              aria-pressed={window === w}
              onClick={() => setWindow(w)}
            >
              {w.toUpperCase()}
            </button>
          ))}
        </div>
        <select
          aria-label="Hitters or pitchers"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
        >
          <option value="hitters">Hitters</option>
          <option value="pitchers">Pitchers</option>
        </select>
      </div>
      {players.length ? (
        <ol className="trending-list" aria-live="polite">
          {players.map((p, i) => (
            <li key={p.playerId}>
              <span className="list-rank">{i + 1}</span>
              <div>
                <div className="trending-player-line">
                  <PlayerLink
                    player={{ id: p.playerId, name: p.name }}
                    level={level}
                  />
                  <span className="trending-context">
                    {p.organization && (
                      <AflOrganizationLink organization={p.organization} />
                    )}
                    {p.team && <AflTeamLink team={p.team} level={level} />}
                  </span>
                </div>
                <div className="performance-summary">
                  {p.summary} <span>· Last {window.toUpperCase()}</span>
                </div>
              </div>
              <span className="trend-value neutral" title={p.sortLabel}>
                {p.sortValue}
                <small>{p.sortLabel}</small>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="empty-state" aria-live="polite">
          No {role} qualify in the last {window.toUpperCase()}.
        </p>
      )}
      <div className="widget-bottom">
        <Link href={`/players?level=${level}`}>Full directory →</Link>
        <span>
          {role === "hitters"
            ? `By OPS, min. ${minPa[window]} PA`
            : "By strikeouts"}{" "}
          · through {asOf}
        </span>
      </div>
    </section>
  );
}

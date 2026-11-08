"use client";
import Link from "next/link";
import { useState } from "react";
import {
  MOMENTUM_WINDOWS,
  MOMENTUM_WINDOW_IDS,
  type MomentumWindow,
  type Role,
} from "@/analytics/config";
import type { TrendingEntry, TrendingSets } from "@/services/home";
import { PlayerLink } from "@/components/ui/entity-links";
import { SourceTag } from "./source-tag";
import { AflOrganizationLink, AflTeamLink } from "@/components/afl/links";
import type { LevelId } from "@/services/players/levels";
import {
  ConfidenceMeter,
  MomentumValue,
} from "@/components/analytics/momentum-parts";

/** Homepage Trending Prospects: V1 Momentum risers and fallers, precomputed on the server. */
export function TrendingProspects({
  sets,
  level,
  levelLabel,
}: {
  sets: TrendingSets;
  level: LevelId;
  levelLabel: string;
}) {
  const [role, setRole] = useState<Role>("hitter");
  const [window, setWindow] = useState<MomentumWindow>("14d");
  const lists = sets.lists[role][window];
  const unavailable = sets.comparable[role][window] === 0;
  return (
    <section className="home-panel" aria-labelledby="trending-title">
      <div className="home-section-heading">
        <h2 id="trending-title">
          Trending Prospects <SourceTag kind="live" />
        </h2>
        <Link href={`/trends?level=${level}`}>All risers &amp; fallers →</Link>
      </div>
      <div className="panel-controls">
        <div className="button-group" role="group" aria-label="Role">
          {(["hitter", "pitcher"] as const).map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={role === r}
              onClick={() => setRole(r)}
            >
              {r === "hitter" ? "Hitters" : "Pitchers"}
            </button>
          ))}
        </div>
        <div className="button-group" role="group" aria-label="Momentum window">
          {MOMENTUM_WINDOW_IDS.map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={window === w}
              onClick={() => setWindow(w)}
            >
              {MOMENTUM_WINDOWS[w].short}
            </button>
          ))}
        </div>
        <span className="small-muted panel-controls-note">
          Momentum: {MOMENTUM_WINDOWS[window].label.toLowerCase()} vs. each
          player&apos;s own earlier {levelLabel} games
        </span>
      </div>
      {unavailable ? (
        <p className="empty-state" aria-live="polite">
          {MOMENTUM_WINDOWS[window].short} unavailable — no{" "}
          {role === "hitter" ? "hitter" : "pitcher"} has enough earlier{" "}
          {levelLabel} games to compare against yet.
        </p>
      ) : (
        <div className="trending-columns" aria-live="polite">
          <TrendColumn title="Trending up" entries={lists.risers} level={level} />
          <TrendColumn title="Cooling" entries={lists.fallers} level={level} />
        </div>
      )}
    </section>
  );
}

function TrendColumn({
  title,
  entries,
  level,
}: {
  title: string;
  entries: TrendingEntry[];
  level: LevelId;
}) {
  return (
    <div className="trend-column">
      <h3 className="mini-heading">{title}</h3>
      {entries.length ? (
        <ol className="trend-rows">
          {entries.map((e) => (
            <li key={e.playerId}>
              <MomentumValue score={e.score} />
              <div className="trend-row-body">
                <div className="trend-row-name">
                  <PlayerLink
                    player={{ id: e.playerId, name: e.name }}
                    level={level}
                  />
                  <span className="trend-row-context">
                    {e.position}
                    {e.team && (
                      <>
                        {" · "}
                        <AflTeamLink team={e.team} level={level} />
                      </>
                    )}
                    {e.organization && (
                      <>
                        {" · "}
                        <AflOrganizationLink organization={e.organization} />
                      </>
                    )}
                  </span>
                </div>
                <div className="trend-row-stats">
                  <span>{e.recentLine}</span>
                  <span className="trend-row-change">{e.keyChange}</span>
                </div>
              </div>
              <ConfidenceMeter
                level={e.confidence}
                detail={`${e.sample.recent} recent vs ${e.sample.baseline} earlier ${e.sample.unit}.`}
              />
            </li>
          ))}
        </ol>
      ) : (
        <p className="empty-state">No qualified players in this window.</p>
      )}
    </div>
  );
}

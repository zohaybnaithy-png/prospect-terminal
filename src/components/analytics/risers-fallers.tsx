"use client";
import { useState } from "react";
import {
  COMPONENTS_BY_ROLE,
  MOMENTUM_WINDOWS,
  MOMENTUM_WINDOW_IDS,
  type MomentumWindow,
  type Role,
} from "@/analytics/config";
import type { RiserCategory } from "@/analytics/engine";
import { COMPONENT_LABELS } from "@/analytics/explain";
import type { RiserCategoryLists, RiserEntryView } from "@/analytics/trend-views";
import { useTrendData } from "./use-trend-data";
import { PlayerLink } from "@/components/ui/entity-links";
import { AflOrganizationLink, AflTeamLink } from "@/components/afl/links";
import type { LevelId } from "@/services/players/levels";
import {
  CONFIDENCE_HELP,
  ConfidenceMeter,
  MomentumValue,
  PERSISTENCE_HELP,
  PersistenceMeter,
} from "./momentum-parts";

/** Biggest Risers / Fallers: ranked by change relative to each player's own baseline at one level. */
export function RisersFallers({
  initial,
  comparable,
  minRecent,
  minBaseline,
  minMagnitude,
  level,
}: {
  level: LevelId;
  /** Lists embedded in the page for the default selection; others load on demand. */
  initial: { role: Role; window: MomentumWindow; lists: RiserCategoryLists };
  /** Players with a valid comparison per role/window; 0 = window unavailable. */
  comparable: Record<Role, Record<MomentumWindow, number>>;
  minRecent: Record<Role, Record<MomentumWindow, number>>;
  minBaseline: Record<Role, number>;
  minMagnitude: number;
}) {
  const [window, setWindow] = useState<MomentumWindow>(initial.window);
  const [role, setRole] = useState<Role>(initial.role);
  const [category, setCategory] = useState<RiserCategory>("overall");
  const cats: RiserCategory[] = ["overall", ...COMPONENTS_BY_ROLE[role]];
  const cat = cats.includes(category) ? category : "overall";
  const unavailable = comparable[role][window] === 0;
  const loaded = useTrendData<RiserCategoryLists>(
    "risers",
    level,
    role,
    window,
    { role: initial.role, window: initial.window, data: initial.lists },
    unavailable,
  );
  const data = (loaded.status === "ok" && loaded.data[cat]) || { risers: [], fallers: [] };
  const unit = role === "hitter" ? "PA" : "BF";
  return (
    <section className="explorer" aria-label="Biggest risers and fallers">
      <div className="section-heading">
        <h2>Biggest Risers &amp; Fallers</h2>
        <span className="small-muted">Change vs. each player&apos;s own earlier games at this level — not raw production</span>
      </div>
      <div className="filter-bar">
        <div className="button-group" role="group" aria-label="Window">
          {MOMENTUM_WINDOW_IDS.map((w) => (
            <button key={w} aria-pressed={window === w} onClick={() => setWindow(w)}>
              {MOMENTUM_WINDOWS[w].short}
            </button>
          ))}
        </div>
        <div className="button-group" role="group" aria-label="Role">
          {(["hitter", "pitcher"] as const).map((r) => (
            <button key={r} aria-pressed={role === r} onClick={() => setRole(r)}>
              {r === "hitter" ? "Hitters" : "Pitchers"}
            </button>
          ))}
        </div>
        <div className="button-group" role="group" aria-label="Component">
          {cats.map((c) => (
            <button key={c} aria-pressed={cat === c} onClick={() => setCategory(c)}>
              {c === "overall" ? "Overall" : COMPONENT_LABELS[c].label}
            </button>
          ))}
        </div>
      </div>
      {unavailable ? (
        <p className="empty-state" aria-live="polite">
          {MOMENTUM_WINDOWS[window].short} unavailable — no{" "}
          {role === "hitter" ? "hitter" : "pitcher"} has enough games at this level
          before this window to compare with yet. No change is estimated.
        </p>
      ) : loaded.status === "loading" ? (
        <p className="empty-state" aria-busy="true">
          Loading {role === "hitter" ? "hitters" : "pitchers"}…
        </p>
      ) : loaded.status === "error" ? (
        <p className="empty-state" role="alert">
          These lists could not be loaded.{" "}
          <button type="button" className="reset-button" onClick={loaded.retry}>
            Try again
          </button>
        </p>
      ) : (
        <div className="riser-columns">
          <RankList title="Risers" entries={data.risers} cat={cat} level={level} />
          <RankList title="Fallers" entries={data.fallers} cat={cat} level={level} />
        </div>
      )}
      <p className="table-note">
        Min. {minRecent[role][window]} {unit} in the window and {minBaseline[role]} {unit} before it;
        changes smaller than ±{minMagnitude} are not listed.
        {cat === "overall"
          ? " Ranked by Momentum (shrunk for sample size and persistence)."
          : ` Ranked by the ${COMPONENT_LABELS[cat].label.toLowerCase()} change (${COMPONENT_LABELS[cat].summary}), shrunk for sample size.`}{" "}
        <span title={CONFIDENCE_HELP}>Confidence: how much data supports the signal.</span>{" "}
        <span title={PERSISTENCE_HELP}>Persistence: how consistently and how long the direction has continued.</span>
      </p>
    </section>
  );
}

function RankList({
  title,
  entries,
  cat,
  level,
}: {
  title: string;
  entries: RiserEntryView[];
  cat: RiserCategory;
  level: LevelId;
}) {
  return (
    <div>
      <h3 className="table-title riser-title">{title}</h3>
      {entries.length ? (
        <ol className="trending-list rank-list" aria-live="polite">
          {entries.map((e, i) => (
            <li key={e.playerId}>
              <span className="list-rank">{i + 1}</span>
              <div>
                <div className="trending-player-line">
                  <PlayerLink player={{ id: e.playerId, name: e.name }} level={level} />
                  <span className="trending-context">
                    {e.organization && <AflOrganizationLink organization={e.organization} />}
                    {e.team && <AflTeamLink team={e.team} level={level} />}
                  </span>
                </div>
                <div className="performance-summary">
                  {e.keyChange} · {e.sample.recent}/{e.sample.baseline} {e.sample.unit}
                  {" · "}
                  {e.persistence}
                </div>
                <div className="rank-meta">
                  <ConfidenceMeter
                    level={e.confidence}
                    detail={`${e.sample.recent} recent vs ${e.sample.baseline} earlier ${e.sample.unit}.`}
                  />
                  <PersistenceMeter level={e.persistenceLevel} />
                </div>
              </div>
              <span className="trend-value neutral">
                <MomentumValue score={e.value} />
                {cat !== "overall" && <small>Mom. {e.score > 0 ? "+" : ""}{e.score}</small>}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="empty-state">No qualified players in this window.</p>
      )}
    </div>
  );
}

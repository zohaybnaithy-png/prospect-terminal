"use client";
import { useState } from "react";
import {
  COMPONENTS_BY_ROLE,
  MODEL_IDS,
  MOMENTUM_MODELS,
  MOMENTUM_WINDOWS,
  MOMENTUM_WINDOW_IDS,
  type ModelId,
  type MomentumWindow,
  type Role,
} from "@/analytics/config";
import type { RankedEntry, RiserCategory } from "@/analytics/engine";
import { COMPONENT_LABELS } from "@/analytics/explain";
import { formatMetric, metricDefinition } from "@/analytics/metrics";
import type { RiserSets } from "@/analytics/views";
import { PlayerLink } from "@/components/ui/entity-links";
import { AflOrganizationLink, AflTeamLink } from "@/components/afl/links";
import { LevelMeter, MomentumValue, persistenceText } from "./momentum-parts";

/** Biggest Risers / Fallers: ranked by change relative to each player's own AFL baseline. */
export function RisersFallers({
  sets,
  minRecent,
  minBaseline,
  minMagnitude,
  defaultModel,
}: {
  sets: RiserSets;
  minRecent: Record<Role, Record<MomentumWindow, number>>;
  minBaseline: Record<Role, number>;
  minMagnitude: number;
  defaultModel: ModelId;
}) {
  const [window, setWindow] = useState<MomentumWindow>("14d");
  const [role, setRole] = useState<Role>("hitter");
  const [category, setCategory] = useState<RiserCategory>("overall");
  const [model, setModel] = useState<ModelId>(defaultModel);
  const cats: RiserCategory[] = ["overall", ...COMPONENTS_BY_ROLE[role]];
  const cat = cats.includes(category) ? category : "overall";
  const data = sets[model][role][window][cat] ?? { risers: [], fallers: [] };
  const unit = role === "hitter" ? "PA" : "BF";
  return (
    <section className="explorer" aria-label="Biggest risers and fallers">
      <div className="section-heading">
        <h2>Biggest Risers &amp; Fallers</h2>
        <span className="small-muted">Change vs. each player&apos;s own earlier AFL games — not raw production</span>
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
        <label className="filter-group">
          <span>Candidate model</span>
          <select value={model} onChange={(e) => setModel(e.target.value as ModelId)}>
            {MODEL_IDS.map((id) => (
              <option key={id} value={id}>
                {MOMENTUM_MODELS[id].label}
                {id === defaultModel ? " (provisional)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="riser-columns">
        <RankList title="Risers" entries={data.risers} cat={cat} />
        <RankList title="Fallers" entries={data.fallers} cat={cat} />
      </div>
      <p className="table-note">
        Min. {minRecent[role][window]} {unit} in the window and {minBaseline[role]} {unit} before it;
        changes smaller than ±{minMagnitude} are not listed.
        {cat === "overall"
          ? " Ranked by Momentum (shrunk for sample size and persistence)."
          : ` Ranked by the ${COMPONENT_LABELS[cat].label.toLowerCase()} change (${COMPONENT_LABELS[cat].summary}), shrunk for sample size.`}{" "}
        Candidate weightings are under review; none is final.
      </p>
    </section>
  );
}

function RankList({ title, entries, cat }: { title: string; entries: RankedEntry[]; cat: RiserCategory }) {
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
                  <PlayerLink player={{ id: e.playerId, name: e.name }} />
                  <span className="trending-context">
                    {e.organization && <AflOrganizationLink organization={e.organization} />}
                    {e.team && <AflTeamLink team={e.team} />}
                  </span>
                </div>
                <div className="performance-summary">
                  {metricDefinition(e.keyMetric).label} {formatMetric(e.keyMetric, e.keyBefore)} →{" "}
                  {formatMetric(e.keyMetric, e.keyNow)} · {e.sample.recent}/{e.sample.baseline} {e.sample.unit}
                  {" · "}
                  {persistenceText({ state: e.persistenceState, trendLengthDays: e.trendLengthDays })}
                </div>
                <div className="rank-meta">
                  <LevelMeter level={e.confidence} label="Conf." />
                  <LevelMeter level={e.persistenceLevel} label="Persist." />
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

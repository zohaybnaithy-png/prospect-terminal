"use client";
import { useState } from "react";
import {
  MOMENTUM_WINDOWS,
  MOMENTUM_WINDOW_IDS,
  type MomentumWindow,
  type Role,
} from "@/analytics/config";
import type { MomentumResult } from "@/analytics/engine";
import { formatMetric, formatMetricChange } from "@/analytics/metrics";
import { shortDate } from "@/lib/format";
import { Decomposition, MomentumMeta, MomentumValue } from "./momentum-parts";

const ROLE_LABEL: Record<Role, string> = { hitter: "Hitting", pitcher: "Pitching" };

/**
 * "What changed?" — before vs. now for one player, with a 7D / 14D / 30D toggle.
 * All values are precomputed server-side; this component only switches between them.
 */
export function WhatChanged({
  roles,
  modelLabel,
}: {
  roles: { role: Role; momentum: Record<MomentumWindow, MomentumResult> }[];
  modelLabel: string;
}) {
  const [window, setWindow] = useState<MomentumWindow>("14d");
  return (
    <div className="analytics-panel">
      <div className="analytics-panel-controls">
        <div className="button-group" role="group" aria-label="Comparison window">
          {MOMENTUM_WINDOW_IDS.map((w) => (
            <button key={w} aria-pressed={window === w} onClick={() => setWindow(w)}>
              {MOMENTUM_WINDOWS[w].short}
            </button>
          ))}
        </div>
        <span className="small-muted">
          {MOMENTUM_WINDOWS[window].label} vs. all earlier AFL games · Momentum
          model: {modelLabel} (provisional)
        </span>
      </div>
      {roles.map(({ role, momentum }) => (
        <RoleChange key={role} role={role} m={momentum[window]} showRole={roles.length > 1} />
      ))}
    </div>
  );
}

function RoleChange({ role, m, showRole }: { role: Role; m: MomentumResult; showRole: boolean }) {
  const r = m.ranges;
  return (
    <div className="what-changed" aria-live="polite">
      {showRole && <h3 className="table-title">{ROLE_LABEL[role]}</h3>}
      <div className="what-changed-head">
        <span className="momentum-label">
          Momentum <MomentumValue score={m.score} large />
          {m.band && <span className="band-label">{m.band.label}</span>}
        </span>
        {m.status === "ok" && <MomentumMeta m={m} />}
      </div>
      <p className="what-changed-explanation">{m.explanation}</p>
      {m.status === "ok" || m.status === "insufficient-baseline" || m.status === "insufficient-recent" ? (
        <div className="what-changed-grid">
          <table className="data-table compact-table">
            <caption className="sr-only">Before and now</caption>
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col" className="numeric" title="All earlier AFL games">
                  Before
                </th>
                <th scope="col" className="numeric">Now</th>
                <th scope="col" className="numeric">Change</th>
              </tr>
            </thead>
            <tbody>
              {m.metrics.map((x) => {
                const better = x.z === null ? 0 : Math.abs(x.z) < 0.1 ? 0 : Math.sign(x.z);
                return (
                  <tr key={x.metric}>
                    <th scope="row">{x.label}</th>
                    <td className="numeric">{formatMetric(x.metric, x.before)}</td>
                    <td className="numeric">{formatMetric(x.metric, x.now)}</td>
                    <td
                      className={`numeric ${better > 0 ? "positive" : better < 0 ? "negative" : ""}`}
                      title={better > 0 ? "Improvement" : better < 0 ? "Decline" : "Little change"}
                    >
                      {formatMetricChange(x.metric, x.delta)}{" "}
                      <span aria-hidden="true" className="change-arrow">
                        {better > 0 ? "▲" : better < 0 ? "▼" : ""}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div>
            <h4 className="mini-heading">Why this Momentum?</h4>
            <Decomposition m={m} />
          </div>
        </div>
      ) : null}
      <p className="table-note">
        Now: {r ? `${shortDate(r.recent.from)}–${shortDate(r.recent.to)}` : "—"},{" "}
        {m.sample.recent} {m.sample.unit}. Before: all earlier AFL games
        {r?.baseline ? ` through ${shortDate(r.baseline.to)}` : ""}, {m.sample.baseline}{" "}
        {m.sample.unit}. Green/red mark improvement/decline for the player (lower K%
        {role === "pitcher" ? ", BB%, WHIP and ERA are" : " is"} better). Completed games only.
      </p>
    </div>
  );
}

"use client";
import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  MOMENTUM_WINDOWS,
  MOMENTUM_WINDOW_IDS,
  type MomentumWindow,
} from "@/analytics/config";
import type { PlayerTimeline, TimelinePoint } from "@/analytics/engine";
import { formatMetric, metricDefinition } from "@/analytics/metrics";
import { shortDate } from "@/lib/format";
import { signedText } from "./momentum-parts";

/**
 * Momentum over time. Each point is the selected window ending on that date compared with all
 * earlier AFL games. `events` overlays dated development events when they exist in the database;
 * none are inferred.
 */
export function DevelopmentTimeline({
  timelines,
  label,
}: {
  timelines: Record<MomentumWindow, PlayerTimeline>;
  label: string;
}) {
  const [window, setWindow] = useState<MomentumWindow>("14d");
  const t = timelines[window];
  const scored = t.points.filter((p) => p.score !== null);
  const keyLabel = metricDefinition(t.keyMetric).label;
  return (
    <div className="score-chart">
      <div className="analytics-panel-controls">
        <div className="button-group" role="group" aria-label={`${label} timeline window`}>
          {MOMENTUM_WINDOW_IDS.map((w) => (
            <button key={w} aria-pressed={window === w} onClick={() => setWindow(w)}>
              {MOMENTUM_WINDOWS[w].short}
            </button>
          ))}
        </div>
        <span className="small-muted">{label} Momentum by date · shaded band = stable (−14 to +14)</span>
      </div>
      {scored.length ? (
        <div
          className="chart-area"
          role="img"
          aria-label={`${label} Momentum by date: ${scored.map((p) => `${shortDate(p.date)} ${p.score}`).join(", ")}`}
        >
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <LineChart data={t.points} margin={{ top: 12, right: 18, bottom: 0, left: -18 }}>
              <CartesianGrid stroke="#dce5e3" vertical={false} />
              <ReferenceArea y1={-14} y2={14} fill="#eef3f2" fillOpacity={1} />
              <ReferenceLine y={0} stroke="#9fb3b0" />
              {t.events.map((e) => (
                <ReferenceLine key={`${e.date}-${e.type}`} x={e.date} stroke="#8a6d3b" strokeDasharray="3 3" label={{ value: e.label, fontSize: 10, fill: "#6b5a35" }} />
              ))}
              <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fill: "#637573", fontSize: 11 }} tickLine={false} minTickGap={28} />
              <YAxis domain={[-100, 100]} ticks={[-100, -50, 0, 50, 100]} tick={{ fill: "#637573", fontSize: 11 }} tickLine={false} />
              <Tooltip content={<TimelineTooltip keyMetric={t.keyMetric} keyLabel={keyLabel} />} />
              <Line
                type="linear"
                dataKey="score"
                name="Momentum"
                stroke="#236e70"
                strokeWidth={2}
                dot={(props: { cx?: number; cy?: number; payload?: TimelinePoint; index?: number }) =>
                  props.cx === undefined || props.cy === undefined || props.payload?.score == null ? (
                    <g key={props.index} />
                  ) : (
                    <circle
                      key={props.index}
                      cx={props.cx}
                      cy={props.cy}
                      r={props.payload.playedOnDate ? 3 : 1.5}
                      fill={props.payload.playedOnDate ? "#236e70" : "#fff"}
                      stroke="#236e70"
                    />
                  )
                }
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="empty-state">
          Not enough earlier AFL games to chart a {MOMENTUM_WINDOWS[window].short} change yet.
        </p>
      )}
      <p className="table-note">
        Filled dots are dates the player appeared. Dated development events
        (promotions, awards, injuries, level changes) are not ingested yet, so
        none are overlaid — none are inferred.
      </p>
    </div>
  );
}

function TimelineTooltip({
  active,
  payload,
  keyMetric,
  keyLabel,
}: {
  active?: boolean;
  payload?: { payload: TimelinePoint }[];
  keyMetric: string;
  keyLabel: string;
}) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div className="chart-tooltip">
      <strong>{shortDate(p.date)}</strong>
      <div>
        Momentum {p.score === null ? "—" : signedText(p.score)}
        {p.score !== null && ` · ${p.confidence} confidence`}
      </div>
      <div>
        Recent {keyLabel} {formatMetric(keyMetric, p.keyRecent)} · baseline{" "}
        {formatMetric(keyMetric, p.keyBaseline)}
      </div>
      {p.topComponents.length > 0 && (
        <div>
          {p.topComponents.map((c) => `${c.label} ${signedText(c.points, 1)}`).join(" · ")}
        </div>
      )}
      <div className="small-muted">
        Sample {p.recentOpportunities} recent / {p.baselineOpportunities} earlier
      </div>
    </div>
  );
}

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
  const [view, setView] = useState<"momentum" | "metric">("momentum");
  const t = timelines[window];
  const scored = t.points.filter((p) => p.score !== null);
  const keyLabel = metricDefinition(t.keyMetric).label;
  return (
    <div className="score-chart">
      <div className="analytics-panel-controls">
        <div
          className="button-group"
          role="group"
          aria-label={`${label} timeline window`}
        >
          {MOMENTUM_WINDOW_IDS.map((w) => (
            <button
              key={w}
              aria-pressed={window === w}
              onClick={() => setWindow(w)}
            >
              {MOMENTUM_WINDOWS[w].short}
            </button>
          ))}
        </div>
        <div
          className="button-group"
          role="group"
          aria-label={`${label} chart view`}
        >
          <button
            type="button"
            aria-pressed={view === "momentum"}
            onClick={() => setView("momentum")}
          >
            Momentum
          </button>
          <button
            type="button"
            aria-pressed={view === "metric"}
            onClick={() => setView("metric")}
          >
            {keyLabel}: recent vs. earlier
          </button>
        </div>
        <span className="small-muted">
          {view === "momentum"
            ? `${label} Momentum by date · shaded band = stable (−14 to +14)`
            : `${label} ${keyLabel} in the ${MOMENTUM_WINDOWS[window].short} window ending each date (solid) vs. all earlier AFL games (dashed)`}
        </span>
      </div>
      {scored.length && view === "metric" ? (
        <MetricChart
          points={t.points}
          keyMetric={t.keyMetric}
          keyLabel={keyLabel}
          label={label}
        />
      ) : scored.length ? (
        <div
          className="chart-area"
          role="img"
          aria-label={`${label} Momentum by date: ${scored.map((p) => `${shortDate(p.date)} ${p.score}`).join(", ")}`}
        >
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <LineChart
              data={t.points}
              margin={{ top: 12, right: 18, bottom: 0, left: -18 }}
            >
              <CartesianGrid stroke="#dce5e3" vertical={false} />
              <ReferenceArea y1={-14} y2={14} fill="#eef3f2" fillOpacity={1} />
              <ReferenceLine y={0} stroke="#9fb3b0" />
              {t.events.map((e) => (
                <ReferenceLine
                  key={`${e.date}-${e.type}`}
                  x={e.date}
                  stroke="#8a6d3b"
                  strokeDasharray="3 3"
                  label={{ value: e.label, fontSize: 10, fill: "#6b5a35" }}
                />
              ))}
              <XAxis
                dataKey="date"
                tickFormatter={shortDate}
                tick={{ fill: "#637573", fontSize: 11 }}
                tickLine={false}
                minTickGap={28}
              />
              <YAxis
                domain={[-100, 100]}
                ticks={[-100, -50, 0, 50, 100]}
                tick={{ fill: "#637573", fontSize: 11 }}
                tickLine={false}
              />
              <Tooltip
                content={
                  <TimelineTooltip
                    keyMetric={t.keyMetric}
                    keyLabel={keyLabel}
                  />
                }
              />
              <Line
                type="linear"
                dataKey="score"
                name="Momentum"
                stroke="#236e70"
                strokeWidth={2}
                dot={(props: {
                  cx?: number;
                  cy?: number;
                  payload?: TimelinePoint;
                  index?: number;
                }) =>
                  props.cx === undefined ||
                  props.cy === undefined ||
                  props.payload?.score == null ? (
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
          {MOMENTUM_WINDOWS[window].short} unavailable — not enough earlier AFL
          games before this window to compare with. No change is estimated.
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
        {p.score !== null && ` · Confidence ${p.confidence}`}
      </div>
      {p.score !== null && <div>{p.persistenceLabel}</div>}
      <div>
        Recent {keyLabel} {formatMetric(keyMetric, p.keyRecent)} · baseline{" "}
        {formatMetric(keyMetric, p.keyBaseline)}
      </div>
      {p.topComponents.length > 0 && (
        <div>
          {p.topComponents
            .map((c) => `${c.label} ${signedText(c.points, 1)}`)
            .join(" · ")}
        </div>
      )}
      <div className="small-muted">
        Sample {p.recentOpportunities} recent / {p.baselineOpportunities}{" "}
        earlier
      </div>
    </div>
  );
}

/** Recent-window value of the key metric vs. the earlier baseline, at each date Momentum exists. */
function MetricChart({
  points,
  keyMetric,
  keyLabel,
  label,
}: {
  points: TimelinePoint[];
  keyMetric: string;
  keyLabel: string;
  label: string;
}) {
  const data = points.map((p) => ({
    date: p.date,
    recent: p.score === null ? null : p.keyRecent,
    baseline: p.score === null ? null : p.keyBaseline,
  }));
  return (
    <div
      className="chart-area"
      role="img"
      aria-label={`${label} ${keyLabel}, recent window vs earlier baseline by date`}
    >
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart
          data={data}
          margin={{ top: 12, right: 18, bottom: 0, left: -6 }}
        >
          <CartesianGrid stroke="#dce5e3" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={shortDate}
            tick={{ fill: "#637573", fontSize: 11 }}
            tickLine={false}
            minTickGap={28}
          />
          <YAxis
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => formatMetric(keyMetric, v)}
            tick={{ fill: "#637573", fontSize: 11 }}
            tickLine={false}
            width={54}
          />
          <Tooltip
            formatter={(v, name) => [
              formatMetric(keyMetric, typeof v === "number" ? v : null),
              name,
            ]}
            labelFormatter={(d) => shortDate(String(d))}
          />
          <Line
            type="linear"
            dataKey="recent"
            name={`Recent ${keyLabel}`}
            stroke="#236e70"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Line
            type="linear"
            dataKey="baseline"
            name={`Earlier ${keyLabel}`}
            stroke="#8a9c9a"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

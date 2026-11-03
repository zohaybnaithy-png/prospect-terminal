"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  Label,
} from "recharts";
import {
  MAP_PERFORMANCE_METRICS,
  MAP_QUADRANT_SPLIT,
  MOMENTUM_WINDOWS,
  MOMENTUM_WINDOW_IDS,
  type MomentumWindow,
  type Role,
} from "@/analytics/config";
import { formatMetric, metricDefinition } from "@/analytics/metrics";
import type { MapPointView, MapSets } from "@/analytics/views";
import { signedText } from "./momentum-parts";

interface Point extends MapPointView {
  x: number;
  xValue: number;
}

const QUADRANTS = [
  { label: "Breakout / emerging", x: 2, y: 96, anchor: "start" },
  { label: "Surging star", x: 98, y: 96, anchor: "end" },
  { label: "Struggling", x: 2, y: -96, anchor: "start" },
  { label: "Established / cooling", x: 98, y: -96, anchor: "end" },
] as const;

/**
 * Performance × Momentum. x = AFL season percentile of one selectable statistic; y = Momentum.
 * Quadrant names are descriptive UI categories, not scouting judgments.
 */
export function PerformanceMap({
  sets,
  comparable,
}: {
  sets: MapSets;
  /** Players with a valid comparison per role/window; 0 = window unavailable. */
  comparable: Record<Role, Record<MomentumWindow, number>>;
}) {
  const router = useRouter();
  const [role, setRole] = useState<Role>("hitter");
  const [window, setWindow] = useState<MomentumWindow>("14d");
  const [metric, setMetric] = useState<string>(MAP_PERFORMANCE_METRICS.hitter[0]);
  const xMetric = MAP_PERFORMANCE_METRICS[role].includes(metric) ? metric : MAP_PERFORMANCE_METRICS[role][0];
  const points: Point[] = useMemo(
    () =>
      sets[role][window].flatMap((p) =>
        p.xs[xMetric] ? [{ ...p, x: p.xs[xMetric][0], xValue: p.xs[xMetric][1] }] : [],
      ),
    [sets, role, window, xMetric],
  );
  const xLabel = metricDefinition(xMetric).label;
  return (
    <section className="explorer" aria-label="Performance by Momentum map">
      <div className="section-heading">
        <h2>Performance × Momentum</h2>
        <span className="small-muted">Click a dot to open the player</span>
      </div>
      <div className="filter-bar">
        <div className="button-group" role="group" aria-label="Role">
          {(["hitter", "pitcher"] as const).map((r) => (
            <button key={r} aria-pressed={role === r} onClick={() => setRole(r)}>
              {r === "hitter" ? "Hitters" : "Pitchers"}
            </button>
          ))}
        </div>
        <div className="button-group" role="group" aria-label="Momentum window">
          {MOMENTUM_WINDOW_IDS.map((w) => (
            <button key={w} aria-pressed={window === w} onClick={() => setWindow(w)}>
              {MOMENTUM_WINDOWS[w].short}
            </button>
          ))}
        </div>
        <label className="filter-group">
          <span>Performance axis (AFL season percentile)</span>
          <select value={xMetric} onChange={(e) => setMetric(e.target.value)}>
            {MAP_PERFORMANCE_METRICS[role].map((m) => (
              <option key={m} value={m}>
                {metricDefinition(m).label}
                {metricDefinition(m).direction < 0 ? " (lower is better)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      {points.length ? (
        <div className="map-area" role="img" aria-label={`${points.length} players: ${xLabel} percentile against Momentum`}>
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <ScatterChart margin={{ top: 14, right: 20, bottom: 26, left: 0 }}>
              <CartesianGrid stroke="#e3e9e8" />
              <XAxis type="number" dataKey="x" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={{ fill: "#637573", fontSize: 11 }} tickLine={false}>
                <Label value={`${xLabel} — AFL season percentile`} position="bottom" offset={6} style={{ fill: "#4b6263", fontSize: 11 }} />
              </XAxis>
              <YAxis type="number" dataKey="y" domain={[-100, 100]} ticks={[-100, -50, 0, 50, 100]} tick={{ fill: "#637573", fontSize: 11 }} tickLine={false}>
                <Label value="Momentum" angle={-90} position="insideLeft" offset={14} style={{ fill: "#4b6263", fontSize: 11 }} />
              </YAxis>
              <ReferenceLine x={MAP_QUADRANT_SPLIT.percentile} stroke="#9fb3b0" />
              <ReferenceLine y={MAP_QUADRANT_SPLIT.momentum} stroke="#9fb3b0" />
              {QUADRANTS.map((q) => (
                <ReferenceLine key={q.label} y={q.y} stroke="none" label={{ value: q.label, position: q.anchor === "start" ? "insideLeft" : "insideRight", fill: "#7b8b89", fontSize: 10 }} />
              ))}
              <Tooltip cursor={false} content={<MapTooltip xMetric={xMetric} />} />
              <Scatter
                data={points}
                fill="#236e70"
                fillOpacity={0.75}
                isAnimationActive={false}
                cursor="pointer"
                onClick={(d: unknown) => {
                  const id = (d as { payload?: Point; playerId?: string })?.payload?.playerId ?? (d as Point)?.playerId;
                  if (id) router.push(`/players/${id}`);
                }}
              />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="empty-state">
          {comparable[role][window] === 0
            ? `${MOMENTUM_WINDOWS[window].short} unavailable — no player has enough AFL games before this window to compare with yet. No change is estimated.`
            : "No players meet the sample minimums for this window yet."}
        </p>
      )}
      <p className="table-note">
        {points.length} qualified players. x is the player&apos;s AFL percentile
        for one season statistic (not a composite performance model); y is{" "}
        {MOMENTUM_WINDOWS[window].short} Momentum.
        Quadrant names are descriptive categories, not scouting conclusions.
      </p>
    </section>
  );
}

function MapTooltip({ active, payload, xMetric }: { active?: boolean; payload?: { payload: Point }[]; xMetric: string }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div className="chart-tooltip">
      <strong>{p.name}</strong>
      <div className="small-muted">
        {[p.team?.abbreviation, p.organization?.abbreviation, p.position].filter(Boolean).join(" · ")}
      </div>
      <div>
        {metricDefinition(xMetric).label} {formatMetric(xMetric, p.xValue)} · {Math.round(p.x)} pctl
      </div>
      <div>
        Momentum {signedText(p.y)} · Confidence {p.confidence} · Persistence {p.persistenceLevel}
      </div>
      <div className="small-muted">{p.persistenceLabel}
      </div>
      <div>
        {metricDefinition(p.keyMetric).label} {formatMetric(p.keyMetric, p.keyBefore)} → {formatMetric(p.keyMetric, p.keyNow)}
      </div>
      <div className="small-muted">
        {p.sample.recent} recent / {p.sample.baseline} earlier {p.sample.unit}
      </div>
    </div>
  );
}

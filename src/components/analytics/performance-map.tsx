"use client";
import type { LevelId } from "@/services/players/levels";
import { playerHref } from "@/components/ui/entity-links";
import { useMemo, useState } from "react";
import { useTrendData } from "./use-trend-data";
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
import { metricDefinition } from "@/analytics/metrics";
import type { MapPointCompact } from "@/analytics/trend-views";
import { signedText } from "./momentum-parts";
import { DataTable, type Column } from "@/components/ui/data-table";
import { PlayerLink } from "@/components/ui/entity-links";

interface Point extends MapPointCompact {
  x: number;
  xText: string;
}


const QUADRANTS = [
  { label: "Breakout / emerging", x: 2, y: 96, anchor: "start" },
  { label: "Surging star", x: 98, y: 96, anchor: "end" },
  { label: "Struggling", x: 2, y: -96, anchor: "start" },
  { label: "Established / cooling", x: 98, y: -96, anchor: "end" },
] as const;

/**
 * Performance × Momentum. x = same-level season percentile of one selectable statistic; y = Momentum.
 * Quadrant names are descriptive UI categories, not scouting judgments.
 */
export function PerformanceMap({
  initial,
  comparable,
  level,
}: {
  level: LevelId;
  /** Points embedded in the page for the default selection; others load on demand. */
  initial: { role: Role; window: MomentumWindow; points: MapPointCompact[] };
  /** Players with a valid comparison per role/window; 0 = window unavailable. */
  comparable: Record<Role, Record<MomentumWindow, number>>;
}) {
  const router = useRouter();
  const [role, setRole] = useState<Role>(initial.role);
  const [window, setWindow] = useState<MomentumWindow>(initial.window);
  const [metric, setMetric] = useState<string>(MAP_PERFORMANCE_METRICS[initial.role][0]);
  const unavailable = comparable[role][window] === 0;
  const current = useTrendData<MapPointCompact[]>(
    "map",
    level,
    role,
    window,
    { role: initial.role, window: initial.window, data: initial.points },
    unavailable,
  );
  const xMetric = MAP_PERFORMANCE_METRICS[role].includes(metric) ? metric : MAP_PERFORMANCE_METRICS[role][0];
  const points: Point[] = useMemo(
    () =>
      current.status === "ok"
        ? current.data.flatMap((p) =>
            p.xs[xMetric] ? [{ ...p, x: p.xs[xMetric][0], xText: p.xs[xMetric][1] }] : [],
          )
        : [],
    [current, xMetric],
  );
  const xLabel = metricDefinition(xMetric).label;
  return (
    <section className="explorer" aria-label="Performance by Momentum map">
      <div className="section-heading">
        <h2>Performance × Momentum</h2>
        <span className="small-muted">Click a dot, or use the player list below the map</span>
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
          <span>Performance axis (season percentile at this level)</span>
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
                <Label value={`${xLabel} — season percentile at this level`} position="bottom" offset={6} style={{ fill: "#4b6263", fontSize: 11 }} />
              </XAxis>
              <YAxis type="number" dataKey="y" domain={[-100, 100]} ticks={[-100, -50, 0, 50, 100]} tick={{ fill: "#637573", fontSize: 11 }} tickLine={false}>
                <Label value="Momentum" angle={-90} position="insideLeft" offset={14} style={{ fill: "#4b6263", fontSize: 11 }} />
              </YAxis>
              <ReferenceLine x={MAP_QUADRANT_SPLIT.percentile} stroke="#9fb3b0" />
              <ReferenceLine y={MAP_QUADRANT_SPLIT.momentum} stroke="#9fb3b0" />
              {QUADRANTS.map((q) => (
                <ReferenceLine key={q.label} y={q.y} stroke="none" label={{ value: q.label, position: q.anchor === "start" ? "insideLeft" : "insideRight", fill: "#637073", fontSize: 10 }} />
              ))}
              <Tooltip cursor={false} content={<MapTooltip xMetric={xMetric} />} />
              <Scatter
                data={points}
                fill="#236e70"
                fillOpacity={0.75}
                isAnimationActive={false}
                cursor="pointer"
                onClick={(d: unknown) => {
                  const id = (d as { payload?: Point; id?: string })?.payload?.id ?? (d as Point)?.id;
                  if (id) router.push(playerHref(id, level));
                }}
              />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      ) : null}
      {points.length ? (
        <MapPointList points={points} xLabel={xLabel} level={level} />
      ) : unavailable ? (
        <p className="empty-state">
          {MOMENTUM_WINDOWS[window].short} unavailable — no player has enough games at this level before this window to compare with yet. No change is estimated.
        </p>
      ) : current.status === "loading" ? (
        <p className="empty-state map-loading" aria-busy="true">
          Loading {role === "hitter" ? "hitters" : "pitchers"}…
        </p>
      ) : current.status === "error" ? (
        <p className="empty-state" role="alert">
          The map points could not be loaded.{" "}
          <button type="button" className="reset-button" onClick={current.retry}>
            Try again
          </button>
        </p>
      ) : (
        <p className="empty-state">No players meet the sample minimums for this window yet.</p>
      )}
      <p className="table-note">
        {current.status === "ok" ? `${points.length} qualified players. ` : ""}x is the player&apos;s percentile at this level
        for one season statistic (not a composite performance model); y is{" "}
        {MOMENTUM_WINDOWS[window].short} Momentum.
        Quadrant names are descriptive categories, not scouting conclusions.
      </p>
    </section>
  );
}

/**
 * The map's points as a table: the keyboard and screen-reader route to every player on the chart
 * (the dots themselves are mouse-only). Collapsed by default, so the map stays the primary view.
 */
export function MapPointList({ points, xLabel, level }: { points: Point[]; xLabel: string; level: LevelId }) {
  const rows = useMemo(() => [...points].sort((a, b) => b.y - a.y || a.name.localeCompare(b.name)), [points]);
  const columns: Column<Point>[] = [
    { key: "player", label: "Player", render: (p) => <PlayerLink player={p} level={level} /> },
    { key: "context", label: "Context", render: (p) => p.context },
    { key: "x", label: xLabel, numeric: true, render: (p) => p.xText },
    { key: "pct", label: "Pctl", title: "Season percentile at this level", numeric: true, render: (p) => Math.round(p.x) },
    { key: "y", label: "Momentum", numeric: true, render: (p) => signedText(p.y) },
    { key: "confidence", label: "Confidence", render: (p) => p.confidence },
  ];
  return (
    <details className="map-points">
      <summary>List the {points.length} players on this map</summary>
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(p) => p.id}
        caption={`Players on the map: ${xLabel} percentile and Momentum, highest Momentum first`}
      />
    </details>
  );
}

function MapTooltip({ active, payload, xMetric }: { active?: boolean; payload?: { payload: Point }[]; xMetric: string }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div className="chart-tooltip">
      <strong>{p.name}</strong>
      <div className="small-muted">{p.context}</div>
      <div>
        {metricDefinition(xMetric).label} {p.xText} · {Math.round(p.x)} pctl
      </div>
      <div>
        Momentum {signedText(p.y)} · Confidence {p.confidence} · Persistence {p.persistenceLevel}
      </div>
      <div className="small-muted">{p.persistenceLabel}</div>
      <div>{p.keyChange}</div>
      <div className="small-muted">{p.sample}</div>
    </div>
  );
}

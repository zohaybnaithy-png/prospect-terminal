"use client";
import { useState } from "react";
import {
  Line,
  LineChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ScoreObservation } from "@/types/baseball";
import { shortDate } from "@/lib/format";
export function ScoreChart({
  observations,
}: {
  observations: ScoreObservation[];
}) {
  const [metric, setMetric] = useState<"grade" | "momentum">("grade");
  return (
    <div className="score-chart">
      <div className="button-group" role="group" aria-label="Trajectory metric">
        <button
          onClick={() => setMetric("grade")}
          aria-pressed={metric === "grade"}
        >
          Prospect Grade
        </button>
        <button
          onClick={() => setMetric("momentum")}
          aria-pressed={metric === "momentum"}
        >
          Momentum
        </button>
      </div>
      <div
        className="chart-area"
        role="img"
        aria-label={`Fictional ${metric} history: ${observations.map((o) => `${shortDate(o.date)}: ${o[metric]}`).join(", ")}`}
      >
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart
            data={observations}
            margin={{ top: 20, right: 20, bottom: 0, left: -16 }}
          >
            <CartesianGrid stroke="#34383d" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={shortDate}
              tick={{ fill: "#a2a7ae", fontSize: 11 }}
              tickLine={false}
              minTickGap={30}
            />
            <YAxis
              domain={metric === "grade" ? [0, 100] : ["auto", "auto"]}
              tick={{ fill: "#a2a7ae", fontSize: 11 }}
              tickLine={false}
            />
            <Tooltip
              labelFormatter={(label) => shortDate(String(label))}
              contentStyle={{
                background: "#25282d",
                border: "1px solid #51565e",
                borderRadius: 0,
                fontSize: 12,
              }}
            />
            <Line
              type="linear"
              dataKey={metric}
              name={metric === "grade" ? "Prospect Grade" : "Momentum"}
              stroke="#7faee8"
              strokeWidth={2}
              dot={{ r: 3 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="table-note">
        Illustrative score observations, not performance-derived analytics.
        Contextual development events are listed alongside this timeline.
      </p>
    </div>
  );
}

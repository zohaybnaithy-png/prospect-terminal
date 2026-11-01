"use client";
import { useState } from "react";
import {
  Area,
  AreaChart,
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
      <div className="chart-toolbar">
        <div className="segmented" aria-label="Chart metric">
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
        <span>6 WEEKS</span>
      </div>
      <div
        className="chart-area"
        role="img"
        aria-label={`Fictional ${metric} history: ${observations.map((o) => `${shortDate(o.date)}: ${o[metric]}`).join(", ")}`}
      >
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <AreaChart
            data={observations}
            margin={{ top: 12, right: 8, bottom: 0, left: -25 }}
          >
            <defs>
              <linearGradient
                id={`score-fill-${metric}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor="#70e0bd" stopOpacity={0.17} />
                <stop offset="100%" stopColor="#70e0bd" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid
              stroke="#253038"
              vertical={false}
              strokeDasharray="3 5"
            />
            <XAxis
              dataKey="date"
              tickFormatter={shortDate}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "#82908f", fontSize: 10 }}
              minTickGap={28}
            />
            <YAxis
              domain={metric === "grade" ? [0, 100] : ["auto", "auto"]}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "#82908f", fontSize: 10 }}
            />
            <Tooltip
              labelFormatter={(label) => shortDate(String(label))}
              contentStyle={{
                background: "#172126",
                border: "1px solid #35433f",
                borderRadius: 6,
                fontSize: 12,
              }}
            />
            <Area
              type="monotone"
              dataKey={metric}
              name={metric === "grade" ? "Prospect Grade" : "Momentum"}
              stroke="#70e0bd"
              strokeWidth={2}
              fill={`url(#score-fill-${metric})`}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="chart-caption">
        Illustrative observations · not calculated analytics
      </p>
    </div>
  );
}

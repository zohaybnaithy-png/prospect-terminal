/** Plain-text (Markdown) rendering of the model comparison, for offline review. */
import { MOMENTUM_SETTINGS } from "./config";
import type { ComparisonEntry, ModelComparison } from "./engine";
import { formatMetric, formatMetricChange } from "./metrics";

const signed = (v: number, d = 0) =>
  `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v).toFixed(d)}`;

function table(title: string, entries: ComparisonEntry[]) {
  const lines = [`#### ${title}`, ""];
  if (!entries.length) return [...lines, "_No qualified players._", ""];
  lines.push(
    "| # | Player | Team | Mom. | Raw | Rel. (conf.) | Sample | Persistence | Contributions (pts) | Before → now |",
    "|---:|---|---|---:|---:|---|---|---|---|---|",
  );
  entries.forEach((e, i) =>
    lines.push(
      `| ${i + 1} | ${e.name} | ${e.team?.abbreviation ?? "—"} | ${signed(e.score)} | ${e.rawScore === null ? "—" : signed(e.rawScore)} | ${e.reliability.toFixed(2)} (${e.confidence}) | ${e.sample.recent}/${e.sample.baseline} ${e.sample.unit} | ${e.persistence.level} — ${e.persistence.label}, ${e.persistence.trendLengthDays}d | ${e.contributions.map((c) => `${c.label} ${signed(c.points, 1)}`).join("; ")} | ${e.metrics.map((m) => `${m.label} ${formatMetric(m.metric, m.before)}→${formatMetric(m.metric, m.now)} (${formatMetricChange(m.metric, m.delta)})`).join("; ")} |`,
    ),
  );
  return [...lines, ""];
}

export function renderComparisonMarkdown(
  cmp: ModelComparison,
  { source }: { source: string },
) {
  const out = [
    `# Momentum model comparison — ${cmp.window.toUpperCase()} window`,
    "",
    `Source: ${source}. As of: ${cmp.asOf ?? "no completed games"}. Qualified: ${cmp.qualified.hitter} hitters, ${cmp.qualified.pitcher} pitchers.`,
    "",
    "Balanced is the V1 default; the other configurations are for comparison only. Settings: " +
      `zDivisor ${MOMENTUM_SETTINGS.scoring.zDivisor}, normalization ${MOMENTUM_SETTINGS.normalization.method}, ` +
      `reliability k ${JSON.stringify(MOMENTUM_SETTINGS.reliability.k)}, persistence floor ${MOMENTUM_SETTINGS.persistence.multiplierFloor}.`,
    "",
    "## Sample sizes and confidence (all players with a valid comparison)",
    "",
    "| Role | Players | Recent [min, p25, med, p75, max] | Earlier | Effective | Low / Medium / High |",
    "|---|---:|---|---|---|---|",
    ...(["hitter", "pitcher"] as const).map((r) => {
      const d = cmp.samples[r];
      return `| ${r} | ${d.players} | ${d.recent.join(", ")} | ${d.baseline.join(", ")} | ${d.effective.join(", ")} | ${d.confidence.low} / ${d.confidence.medium} / ${d.confidence.high} |`;
    }),
    "",
    `Confidence thresholds: reliability ≥ ${MOMENTUM_SETTINGS.confidence.levels.medium} and ≥ ${JSON.stringify(MOMENTUM_SETTINGS.confidence.minSample.medium)} on both sides for Medium; ≥ ${MOMENTUM_SETTINGS.confidence.levels.high} and ≥ ${JSON.stringify(MOMENTUM_SETTINGS.confidence.minSample.high)} on both sides for High.`,
    "",
    "## Agreement",
    "",
    "| Pair | Role | Spearman ρ | Shared top-N |",
    "|---|---|---:|---:|",
    ...cmp.agreement.map(
      (a) =>
        `| ${a.a} vs ${a.b} | ${a.role} | ${a.spearman === null ? "—" : a.spearman.toFixed(2)} | ${a.topOverlap} |`,
    ),
    "",
  ];
  for (const { model, hitters, pitchers } of cmp.models) {
    out.push(
      `## ${model.label}`,
      "",
      `${model.description}`,
      "",
      `Hitter weights: ${JSON.stringify(model.hitter)}  `,
      `Pitcher weights: ${JSON.stringify(model.pitcher)}`,
      "",
      ...table("Top hitter Momentum", hitters.top),
      ...table("Bottom hitter Momentum", hitters.bottom),
      ...table("Top pitcher Momentum", pitchers.top),
      ...table("Bottom pitcher Momentum", pitchers.bottom),
    );
  }
  return out.join("\n");
}

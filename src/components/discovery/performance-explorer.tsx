"use client";
import { useState } from "react";
import type {
  Catalog,
  DiscoveryFilters,
  RankingMode,
  TimeWindow,
  PlayerType,
} from "@/types/baseball";
import {
  defaultFilters,
  discoverDemoPlayers,
  windowLabels,
} from "@/services/discovery";
import { PlayerTable } from "@/components/market/player-table";
import { DEMO_AS_OF } from "@/data/demo";
const rankingLabels = {
  priority: "Prospect Priority",
  performance: "Pure Performance",
};
function ButtonGroup<T extends string>({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: T;
  items: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="filter-group">
      <span>{label}</span>
      <div className="button-group" role="group" aria-label={label}>
        {items.map((item) => (
          <button
            key={item.value}
            aria-pressed={value === item.value}
            onClick={() => onChange(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
export function PerformanceExplorer({
  catalog,
  initial = {},
  variant = "discovery",
  title = "Who’s balling out?",
  lockedContext = false,
}: {
  catalog: Catalog;
  initial?: Partial<DiscoveryFilters>;
  variant?: "discovery" | "directory" | "data" | "screener";
  title?: string;
  lockedContext?: boolean;
}) {
  const baseline = {
    ...defaultFilters,
    ...(variant === "data" ? { type: "hitters" as const } : {}),
    ...initial,
  };
  const [filters, setFilters] = useState<DiscoveryFilters>(baseline);
  const update = <K extends keyof DiscoveryFilters>(
    key: K,
    value: DiscoveryFilters[K],
  ) => setFilters((old) => ({ ...old, [key]: value }));
  const players = discoverDemoPlayers(catalog, filters);
  return (
    <section className="explorer" aria-label={title}>
      <div className="section-heading">
        <h2>{title}</h2>
        <span className="small-muted">Fictional snapshot · {DEMO_AS_OF}</span>
      </div>
      <div className="filter-bar">
        <ButtonGroup<RankingMode>
          label="Ranking"
          value={filters.ranking}
          items={[
            { value: "priority", label: "Prospect Priority" },
            { value: "performance", label: "Pure Performance" },
          ]}
          onChange={(v) => update("ranking", v)}
        />
        <label className="filter-group">
          <span>Level / league</span>
          <select
            aria-label="Level or league"
            disabled={lockedContext}
            value={filters.context}
            onChange={(e) => update("context", e.target.value)}
          >
            <option value="all">All Levels</option>
            {catalog.contexts.map((c) => (
              <option key={c.id} value={c.slug}>
                {c.name === "Triple-A"
                  ? "AAA"
                  : c.name === "Double-A"
                    ? "AA"
                    : c.name}
              </option>
            ))}
          </select>
        </label>
        <ButtonGroup<TimeWindow>
          label="Timeframe"
          value={filters.window}
          items={[
            { value: "7d", label: "7D" },
            { value: "14d", label: "14D" },
            { value: "30d", label: "30D" },
            { value: "season", label: "Season" },
          ]}
          onChange={(v) => update("window", v)}
        />
        <ButtonGroup<PlayerType>
          label="Player type"
          value={filters.type}
          items={[
            ...(variant === "data"
              ? []
              : [{ value: "all" as const, label: "All" }]),
            {
              value: "hitters",
              label: variant === "data" ? "Hitting" : "Hitters",
            },
            {
              value: "pitchers",
              label: variant === "data" ? "Pitching" : "Pitchers",
            },
          ]}
          onChange={(v) => update("type", v)}
        />
      </div>
      {variant !== "discovery" && (
        <div className="filter-bar secondary-filters">
          <label className="search-label">
            <span className="sr-only">Search players or teams</span>
            <input
              aria-label="Search players or teams"
              value={filters.query}
              onChange={(e) => update("query", e.target.value)}
              placeholder="Player, team, or organization"
            />
          </label>
          <label>
            <span className="sr-only">Organization filter</span>
            <select
              aria-label="Organization filter"
              value={filters.organization}
              onChange={(e) => update("organization", e.target.value)}
            >
              <option value="">All organizations</option>
              {catalog.organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Team filter</span>
            <select
              aria-label="Team filter"
              value={filters.team}
              onChange={(e) => update("team", e.target.value)}
            >
              <option value="">All teams</option>
              {catalog.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {variant === "screener" && (
            <>
              <label className="numeric-filter">
                Min grade
                <input
                  aria-label="Minimum grade"
                  type="number"
                  min="0"
                  max="100"
                  value={filters.minGrade}
                  onChange={(e) =>
                    update(
                      "minGrade",
                      Math.min(100, Math.max(0, Number(e.target.value))),
                    )
                  }
                />
              </label>
              <label className="numeric-filter">
                Min momentum
                <input
                  aria-label="Minimum momentum"
                  type="number"
                  step="0.1"
                  value={filters.minMomentum ?? ""}
                  onChange={(e) =>
                    update(
                      "minMomentum",
                      e.target.value === "" ? null : Number(e.target.value),
                    )
                  }
                />
              </label>
              <label className="numeric-filter">
                Max age
                <input
                  aria-label="Maximum age"
                  type="number"
                  min="0"
                  value={filters.maxAge ?? ""}
                  onChange={(e) =>
                    update(
                      "maxAge",
                      e.target.value === ""
                        ? null
                        : Math.max(0, Number(e.target.value)),
                    )
                  }
                />
              </label>
              <select
                aria-label="Position filter"
                value={filters.position}
                onChange={(e) => update("position", e.target.value)}
              >
                <option value="">All positions</option>
                {[...new Set(catalog.players.map((p) => p.position))].map(
                  (p) => (
                    <option key={p}>{p}</option>
                  ),
                )}
              </select>
            </>
          )}
          <button
            className="reset-button"
            onClick={() => setFilters({ ...baseline, query: "" })}
          >
            Reset filters
          </button>
        </div>
      )}
      <div className="table-context" aria-live="polite">
        <strong>{players.length} players</strong>
        <span>
          {rankingLabels[filters.ranking]} · {windowLabels[filters.window]} ·{" "}
          {filters.context === "all"
            ? "All levels"
            : catalog.contexts.find((c) => c.slug === filters.context)?.name}
        </span>
        <span>DEMO ORDER</span>
      </div>
      <PlayerTable
        key={`${filters.ranking}-${filters.window}-${filters.type}-${filters.context}-${filters.query}-${filters.organization}-${filters.team}-${filters.minGrade}-${filters.minMomentum}-${filters.maxAge}-${filters.position}`}
        players={players}
        catalog={catalog}
        window={filters.window}
        type={filters.type}
        expanded={variant === "data"}
      />
      <p className="table-note">
        {filters.ranking === "priority"
          ? "Prospect Priority: hand-curated demo order emphasizing higher-level performance and development context."
          : "Pure Performance: alternate hand-curated demo order; lower-level standouts can lead."}{" "}
        No ranking formula is implemented. Stats are fictional window snapshots;
        Season covers the current team stint. Grade and Momentum remain
        as-of-snapshot values. Click a numeric header to sort the displayed
        rows.
      </p>
    </section>
  );
}

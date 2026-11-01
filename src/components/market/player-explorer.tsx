"use client";
import { useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import type { Player, Team } from "@/types/baseball";
import { PlayerTable } from "./player-table";
export function PlayerExplorer({
  players,
  teams,
  initialQuery = "",
  initialSort = "grade",
  screener = false,
}: {
  players: Player[];
  teams: Team[];
  initialQuery?: string;
  initialSort?: string;
  screener?: boolean;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [team, setTeam] = useState("");
  const [role, setRole] = useState("");
  const [sort, setSort] = useState(initialSort);
  const [minGrade, setMinGrade] = useState(0);
  const filtered = players
    .filter(
      (p) =>
        `${p.name} ${teams.find((t) => t.id === p.teamId)?.name}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (!team || p.teamId === team) &&
        (!role || (role === "pitchers" ? !!p.pitching : !!p.batting)) &&
        p.grade >= minGrade,
    )
    .sort((a, b) =>
      sort === "momentum"
        ? b.momentum - a.momentum
        : sort === "falling"
          ? a.momentum - b.momentum
          : b.grade - a.grade,
    );
  return (
    <section className="panel">
      <div className="explorer-toolbar">
        <label className="search-field">
          <Search size={16} />
          <span className="sr-only">Find a player or team</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a player or team…"
          />
        </label>
        <label>
          <span className="sr-only">Team</span>
          <select
            aria-label="Team"
            value={team}
            onChange={(e) => setTeam(e.target.value)}
          >
            <option value="">All teams</option>
            {teams.map((t) => (
              <option value={t.id} key={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Player role</span>
          <select
            aria-label="Player role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="">All roles</option>
            <option value="hitters">Hitters</option>
            <option value="pitchers">Pitchers</option>
          </select>
        </label>
        <label>
          <span className="sr-only">Sort players</span>
          <select
            aria-label="Sort players"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="grade">Grade: high to low</option>
            <option value="momentum">Momentum: rising</option>
            <option value="falling">Momentum: falling</option>
          </select>
        </label>
        {screener && (
          <label className="grade-filter">
            <SlidersHorizontal size={15} />
            Min. grade{" "}
            <input
              type="number"
              min="0"
              max="100"
              value={minGrade}
              onChange={(e) =>
                setMinGrade(Math.max(0, Math.min(100, Number(e.target.value))))
              }
            />
          </label>
        )}
        <button
          className="reset-button"
          onClick={() => {
            setQuery("");
            setTeam("");
            setRole("");
            setSort("grade");
            setMinGrade(0);
          }}
        >
          <X size={14} /> Reset
        </button>
      </div>
      <div className="results-count" aria-live="polite">
        {filtered.length} of {players.length} fictional prospects{" "}
        <span>2026 DEMO SEASON · NCAA D1</span>
      </div>
      <PlayerTable players={filtered} teams={teams} />
    </section>
  );
}

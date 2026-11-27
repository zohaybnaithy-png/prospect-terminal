/**
 * Clearly fictional season for exercising the breakout validation offline (tests and `--synthetic`).
 * Some players get a planted, real skill change mid-season; the rest are stationary. NOT real data.
 */
import { addDays, rng } from "../src/analytics/breakout/detector";
import type { AflBattingLine, AflGame, AflPitchingLine, AflPlayer, AflSnapshot } from "../src/services/afl/types";

export interface SyntheticOptions {
  seed?: number;
  hitters?: number;
  pitchers?: number;
  /** Share of players with a planted improvement. */
  breakoutShare?: number;
  days?: number;
  year?: number;
  /** Multiplier on the planted change (1 = K% −10 pts, BB% +5, ISO +.100 for hitters; K% +12, BB% −4 for pitchers). */
  effect?: number;
}

export interface SyntheticSeason {
  snapshot: AflSnapshot;
  /** Players whose skills were changed, and the date the change took effect. */
  planted: Map<string, string>;
}

const binom = (n: number, p: number, rand: () => number) => {
  let k = 0;
  for (let i = 0; i < n; i++) if (rand() < p) k++;
  return k;
};

export function syntheticSeason(o: SyntheticOptions = {}): SyntheticSeason {
  const rand = rng(o.seed ?? 7);
  const year = o.year ?? 2026;
  const days = o.days ?? 160;
  const start = `${year}-04-08`;
  const games: AflGame[] = [];
  for (let d = 0; d < days; d++) {
    const date = addDays(start, d);
    games.push({
      id: `00000000-0000-4000-8000-${String(d).padStart(12, "0")}`,
      date, startsAt: `${date}T23:00:00Z`, status: "final", homeTeamId: "00000000-0000-4000-a000-000000000001", awayTeamId: "00000000-0000-4000-a000-000000000002",
      homeScore: 1, awayScore: 0, venue: null, boxscoreComplete: true,
    });
  }
  const players: AflPlayer[] = [];
  const batting: AflBattingLine[] = [];
  const pitching: AflPitchingLine[] = [];
  const planted = new Map<string, string>();
  const share = o.breakoutShare ?? 0.1;
  const fx = o.effect ?? 1;
  const player = (i: number, pos: string): AflPlayer => ({
    id: `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`,
    name: `Synthetic Player ${i}`, primaryPosition: pos, secondaryPosition: null, bats: null, throws: null,
    birthDate: null, height: null, weight: null,
  });
  const change = () => addDays(start, 45 + Math.floor(rand() * 60));
  for (let i = 0; i < (o.hitters ?? 120); i++) {
    const p = player(i, "OF");
    players.push(p);
    let k = 0.12 + rand() * 0.22;
    let bb = 0.04 + rand() * 0.12;
    let iso = 0.05 + rand() * 0.2;
    const when = rand() < share ? change() : null;
    if (when) planted.set(p.id, when);
    let changed = false;
    for (const g of games) {
      if (when && !changed && g.date >= when) { k = Math.max(0.05, k - 0.1 * fx); bb = Math.min(0.3, bb + 0.05 * fx); iso += 0.1 * fx; changed = true; }
      if (rand() < 0.15) continue; // off day
      const pa = 4;
      const so = binom(pa, k, rand);
      const w = binom(pa - so, bb / (1 - k), rand);
      const ab = pa - w;
      const inPlay = ab - so;
      const hits = binom(inPlay, 0.3, rand);
      const q = Math.min(0.9, iso / 1.6);
      const doubles = binom(hits, q, rand);
      const hr = binom(hits - doubles, Math.min(0.9, q / 5), rand);
      batting.push({
        playerId: p.id, gameId: g.id, teamId: "00000000-0000-4000-a000-000000000001", plateAppearances: pa, atBats: ab, hits, doubles, triples: 0,
        homeRuns: hr, walks: w, strikeouts: so, hitByPitch: 0, sacrificeFlies: 0, stolenBases: 0,
      });
    }
  }
  for (let i = 0; i < (o.pitchers ?? 120); i++) {
    const p = player(10000 + i, "P");
    players.push(p);
    let k = 0.14 + rand() * 0.2;
    let bb = 0.05 + rand() * 0.08;
    const when = rand() < share ? change() : null;
    if (when) planted.set(p.id, when);
    let changed = false;
    for (let gi = i % 5; gi < games.length; gi += 5) {
      const g = games[gi];
      if (when && !changed && g.date >= when) { k = Math.min(0.6, k + 0.12 * fx); bb = Math.max(0.02, bb - 0.04 * fx); changed = true; }
      const bf = 22;
      const so = binom(bf, k, rand);
      const w = binom(bf - so, bb / (1 - k), rand);
      const er = binom(5, 0.4, rand);
      pitching.push({
        playerId: p.id, gameId: g.id, teamId: "00000000-0000-4000-a000-000000000001", outsRecorded: 16, battersFaced: bf, hitsAllowed: 5,
        earnedRuns: er, walks: w, strikeouts: so, homeRunsAllowed: 0,
      });
    }
  }
  return {
    snapshot: {
      league: { id: "00000000-0000-4000-b000-000000000001", name: "Synthetic League (fictional)" },
      season: { id: "00000000-0000-4000-b000-000000000002", year, name: `${year} synthetic` },
      teams: [{ id: "00000000-0000-4000-a000-000000000001", name: "Synthetic A", abbreviation: "SYA" }, { id: "00000000-0000-4000-a000-000000000002", name: "Synthetic B", abbreviation: "SYB" }], organizations: [], players, games, rosterStints: [], batting, pitching, lastIngestedAt: null,
    },
    planted,
  };
}

/**
 * Clearly fictional seasons for exercising the similarity validation offline (tests and `--synthetic`). NOT real data.
 *
 * - "types": players are drawn around a few distinct archetypes (talent + age + usage), so real similarity exists and
 *   the validation should find it (criteria 1 and 2 pass).
 * - "null": every player has the same true talent and no birth date, so any similarity is noise and the validation
 *   should reject it (criteria 1 and 2 fail).
 */
import { rng } from "../src/analytics/similarity/profiles";
import type { AflBattingLine, AflGame, AflPitchingLine, AflPlayer, AflSnapshot } from "../src/services/afl/types";

export type SyntheticMode = "types" | "null";

export interface SyntheticOptions {
  seed?: number;
  hitters?: number;
  pitchers?: number;
  days?: number;
  year?: number;
  mode?: SyntheticMode;
}

const TEAM_A = "00000000-0000-4000-a000-000000000001";
const TEAM_B = "00000000-0000-4000-a000-000000000002";

function addDays(date: string, n: number) {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

interface HitterTalent { k: number; bb: number; hr: number; babip: number; xbh: number; sb: number; age: number }
interface PitcherTalent { k: number; bb: number; hr: number; babip: number; starter: boolean; age: number }

const HITTER_TYPES: HitterTalent[] = [
  { k: 0.30, bb: 0.13, hr: 0.07, babip: 0.29, xbh: 0.35, sb: 0.03, age: 23.5 }, // three true outcomes
  { k: 0.14, bb: 0.07, hr: 0.01, babip: 0.33, xbh: 0.20, sb: 0.25, age: 20.5 }, // young contact speedster
  { k: 0.20, bb: 0.10, hr: 0.035, babip: 0.31, xbh: 0.28, sb: 0.08, age: 22 },  // balanced
  { k: 0.25, bb: 0.06, hr: 0.05, babip: 0.27, xbh: 0.30, sb: 0.02, age: 25.5 }, // older free swinger
  { k: 0.17, bb: 0.15, hr: 0.02, babip: 0.30, xbh: 0.22, sb: 0.12, age: 21.5 }, // patient table setter
  { k: 0.33, bb: 0.08, hr: 0.03, babip: 0.34, xbh: 0.25, sb: 0.15, age: 20 },   // raw young athlete
];

const PITCHER_TYPES: PitcherTalent[] = [
  { k: 0.32, bb: 0.11, hr: 0.025, babip: 0.29, starter: false, age: 23 }, // power reliever
  { k: 0.18, bb: 0.05, hr: 0.03, babip: 0.31, starter: true, age: 24.5 }, // strike-thrower starter
  { k: 0.27, bb: 0.08, hr: 0.02, babip: 0.30, starter: true, age: 21 },  // young power starter
  { k: 0.21, bb: 0.12, hr: 0.035, babip: 0.32, starter: false, age: 25.5 }, // wild older reliever
  { k: 0.24, bb: 0.07, hr: 0.015, babip: 0.28, starter: true, age: 22.5 }, // ground-ball starter
];

const LEAGUE_HITTER: HitterTalent = { k: 0.22, bb: 0.10, hr: 0.035, babip: 0.31, xbh: 0.27, sb: 0.1, age: 22.5 };
const LEAGUE_PITCHER: PitcherTalent = { k: 0.24, bb: 0.09, hr: 0.025, babip: 0.30, starter: true, age: 23 };

export function syntheticSeason(o: SyntheticOptions = {}): AflSnapshot {
  const rand = rng(o.seed ?? 7);
  const mode = o.mode ?? "types";
  const year = o.year ?? 2026;
  const days = o.days ?? 165; // 8 Apr – 19 Sep, about a MiLB season
  const start = `${year}-04-08`;
  const games: AflGame[] = [];
  for (let d = 0; d < days; d++) {
    const date = addDays(start, d);
    games.push({
      id: `00000000-0000-4000-8000-${String(d).padStart(12, "0")}`,
      date, startsAt: `${date}T23:00:00Z`, status: "final", homeTeamId: TEAM_A, awayTeamId: TEAM_B,
      homeScore: 1, awayScore: 0, venue: null, boxscoreComplete: true,
    });
  }
  const jitter = (x: number, s: number, lo: number, hi: number) => {
    // Sum of uniforms ≈ normal; small individual differences around the archetype.
    const n = (rand() + rand() + rand() + rand() - 2) * Math.sqrt(3);
    return Math.min(hi, Math.max(lo, x + n * s));
  };
  const birth = (age: number) => (mode === "null" ? null : addDays(`${year}-07-01`, -Math.round(jitter(age, 0.7, 17, 30) * 365.2425)));
  const players: AflPlayer[] = [];
  const batting: AflBattingLine[] = [];
  const pitching: AflPitchingLine[] = [];
  const hand = () => (rand() < 0.3 ? "L" : "R");
  for (let i = 0; i < (o.hitters ?? 240); i++) {
    const base = mode === "null" ? LEAGUE_HITTER : HITTER_TYPES[i % HITTER_TYPES.length];
    const s = mode === "null" ? 0 : 1;
    const t: HitterTalent = {
      k: jitter(base.k, 0.015 * s, 0.05, 0.45), bb: jitter(base.bb, 0.01 * s, 0.02, 0.2), hr: jitter(base.hr, 0.004 * s, 0.002, 0.1),
      babip: jitter(base.babip, 0.01 * s, 0.2, 0.4), xbh: jitter(base.xbh, 0.02 * s, 0.05, 0.5), sb: jitter(base.sb, 0.02 * s, 0, 0.4), age: base.age,
    };
    const p: AflPlayer = {
      id: `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`, name: `Synthetic Hitter ${i}`,
      primaryPosition: ["C", "SS", "2B", "CF", "RF", "1B"][Math.floor(rand() * 6)], secondaryPosition: null, bats: hand(), throws: "R",
      birthDate: birth(t.age), height: null, weight: null,
    };
    players.push(p);
    for (const g of games) {
      if (rand() < 0.15) continue; // off day
      const l: AflBattingLine = {
        playerId: p.id, gameId: g.id, teamId: TEAM_A, plateAppearances: 4, atBats: 0, hits: 0, doubles: 0, triples: 0,
        homeRuns: 0, walks: 0, strikeouts: 0, hitByPitch: 0, sacrificeFlies: 0, stolenBases: 0,
      };
      let onFirst = 0;
      for (let pa = 0; pa < 4; pa++) {
        const u = rand();
        if (u < t.k) { l.strikeouts++; l.atBats++; }
        else if (u < t.k + t.bb) { l.walks++; onFirst++; }
        else if (u < t.k + t.bb + 0.01) { l.hitByPitch++; onFirst++; }
        else {
          l.atBats++;
          if (rand() < t.hr / (1 - t.k - t.bb - 0.01)) { l.homeRuns++; l.hits++; }
          else if (rand() < t.babip) {
            l.hits++;
            const x = rand();
            if (x < 0.03) l.triples++;
            else if (x < t.xbh) l.doubles++;
            else onFirst++;
          }
        }
      }
      for (let r = 0; r < onFirst; r++) if (rand() < t.sb) l.stolenBases++;
      batting.push(l);
    }
  }
  for (let i = 0; i < (o.pitchers ?? 240); i++) {
    const base = mode === "null" ? LEAGUE_PITCHER : PITCHER_TYPES[i % PITCHER_TYPES.length];
    const s = mode === "null" ? 0 : 1;
    const t: PitcherTalent = {
      k: jitter(base.k, 0.015 * s, 0.08, 0.45), bb: jitter(base.bb, 0.01 * s, 0.02, 0.2), hr: jitter(base.hr, 0.004 * s, 0.002, 0.08),
      babip: jitter(base.babip, 0.01 * s, 0.2, 0.4), starter: base.starter, age: base.age,
    };
    const p: AflPlayer = {
      id: `00000000-0000-4000-9000-${String(10000 + i).padStart(12, "0")}`, name: `Synthetic Pitcher ${i}`,
      primaryPosition: "P", secondaryPosition: null, bats: "R", throws: hand(), birthDate: birth(t.age), height: null, weight: null,
    };
    players.push(p);
    const step = t.starter ? 5 : 2;
    for (let gi = i % step; gi < games.length; gi += step) {
      const bf = t.starter ? 20 + Math.floor(rand() * 6) : 3 + Math.floor(rand() * 4);
      const l: AflPitchingLine = {
        playerId: p.id, gameId: games[gi].id, teamId: TEAM_A, outsRecorded: 0, battersFaced: bf, hitsAllowed: 0,
        earnedRuns: 0, walks: 0, strikeouts: 0, homeRunsAllowed: 0, hitBatters: 0,
      };
      for (let b = 0; b < bf; b++) {
        const u = rand();
        if (u < t.k) { l.strikeouts++; l.outsRecorded++; }
        else if (u < t.k + t.bb) l.walks++;
        else if (u < t.k + t.bb + t.hr) { l.homeRunsAllowed++; l.hitsAllowed++; l.earnedRuns++; }
        else if (rand() < t.babip) l.hitsAllowed++;
        else l.outsRecorded++;
      }
      pitching.push(l);
    }
  }
  return {
    league: { id: "00000000-0000-4000-b000-000000000001", name: "Synthetic League (fictional)" },
    season: { id: "00000000-0000-4000-b000-000000000002", year, name: `${year} synthetic` },
    teams: [{ id: TEAM_A, name: "Synthetic A", abbreviation: "SYA" }, { id: TEAM_B, name: "Synthetic B", abbreviation: "SYB" }],
    organizations: [], players, games, rosterStints: [], batting, pitching, lastIngestedAt: null,
  };
}

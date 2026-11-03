/**
 * Clearly fictional AFL-shaped snapshots for analytics tests. Internal-style UUIDs only; no
 * provider IDs, no real players. Lines are deterministic cycles so expectations are exact.
 */
import type {
  AflBattingLine,
  AflGame,
  AflPitchingLine,
  AflSnapshot,
} from "../src/services/afl/types";

export const u = (n: number) =>
  `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
export const LEAGUE = u(1),
  SEASON = u(2),
  T1 = u(11),
  T2 = u(12),
  ORG = u(21);

export type BatLine = Omit<AflBattingLine, "playerId" | "gameId" | "teamId">;
export type PitchLine = Omit<AflPitchingLine, "playerId" | "gameId" | "teamId">;

export const bl = (
  pa: number,
  ab: number,
  h: number,
  { d = 0, hr = 0, bb = 0, k = 0 }: { d?: number; hr?: number; bb?: number; k?: number } = {},
): BatLine => ({
  plateAppearances: pa,
  atBats: ab,
  hits: h,
  doubles: d,
  triples: 0,
  homeRuns: hr,
  walks: bb,
  strikeouts: k,
  hitByPitch: 0,
  sacrificeFlies: 0,
  stolenBases: 0,
  runs: 0,
  rbi: 0,
  caughtStealing: 0,
});
export const pl = (
  outs: number,
  bf: number,
  { h = 0, er = 0, bb = 0, k = 0 }: { h?: number; er?: number; bb?: number; k?: number } = {},
): PitchLine => ({
  outsRecorded: outs,
  battersFaced: bf,
  hitsAllowed: h,
  earnedRuns: er,
  walks: bb,
  strikeouts: k,
  homeRunsAllowed: 0,
  runs: er,
  hitBatters: 0,
  pitches: 30,
});

/** Weak / average / strong 4-PA game cycles (3-game cycles keep 27-day seasons balanced). */
export const WEAK: BatLine[] = [
  bl(4, 4, 1, { k: 2 }),
  bl(4, 4, 0, { k: 2 }),
  bl(4, 4, 1, { k: 1 }),
];
export const MID: BatLine[] = [
  bl(4, 4, 1, { d: 1, k: 1 }),
  bl(4, 3, 1, { bb: 1, k: 1 }),
  bl(4, 4, 1, { k: 1 }),
];
export const STRONG: BatLine[] = [
  bl(4, 3, 2, { d: 1, bb: 1 }),
  bl(4, 4, 2, { hr: 1, k: 1 }),
  bl(4, 3, 1, { hr: 1, bb: 1 }),
];
export const P_WEAK: PitchLine[] = [
  pl(6, 10, { h: 3, er: 2, bb: 2, k: 1 }),
  pl(6, 9, { h: 2, er: 1, bb: 1, k: 1 }),
];
export const P_STRONG: PitchLine[] = [
  pl(6, 7, { h: 1, er: 0, bb: 0, k: 4 }),
  pl(6, 7, { h: 1, er: 0, bb: 0, k: 3 }),
];

export interface SyntheticPlayer {
  id: string;
  name: string;
  position?: string;
  /** Batting line for season day index d, or null for no game. */
  batting?: (d: number) => BatLine | null;
  pitching?: (d: number) => PitchLine | null;
  team?: string;
}

export const START = "2026-10-06";
export const dayDate = (d: number) => {
  const x = new Date(`${START}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
};

/**
 * One final, complete game per day for `days` days, plus one non-final and one incomplete game
 * (whose lines must be ignored by every window).
 */
export function syntheticSnapshot(
  players: SyntheticPlayer[],
  days = 27,
  { extraGames = true }: { extraGames?: boolean } = {},
): AflSnapshot {
  const games: AflGame[] = [];
  const batting: AflBattingLine[] = [];
  const pitching: AflPitchingLine[] = [];
  const game = (n: number, date: string, status: string, complete: boolean): AflGame => ({
    id: u(1000 + n),
    date,
    startsAt: `${date}T19:05:00.000Z`,
    status,
    homeTeamId: T1,
    awayTeamId: T2,
    homeScore: status === "final" ? 3 : null,
    awayScore: status === "final" ? 2 : null,
    venue: "Synthetic Park",
    boxscoreComplete: complete,
  });
  for (let d = 0; d < days; d++) {
    const g = game(d, dayDate(d), "final", true);
    games.push(g);
    for (const p of players) {
      const b = p.batting?.(d);
      if (b) batting.push({ ...b, playerId: p.id, gameId: g.id, teamId: p.team ?? T1 });
      const pi = p.pitching?.(d);
      if (pi) pitching.push({ ...pi, playerId: p.id, gameId: g.id, teamId: p.team ?? T1 });
    }
  }
  if (extraGames && days > 0) {
    // Excluded games carry absurd lines; any leak into a window would be obvious.
    const scheduled = game(900, dayDate(days), "scheduled", false);
    const incomplete = game(901, dayDate(days - 1), "final", false);
    games.push(scheduled, incomplete);
    for (const g of [scheduled, incomplete])
      for (const p of players) {
        if (p.batting)
          batting.push({ ...bl(10, 10, 10, { hr: 10 }), playerId: p.id, gameId: g.id, teamId: T1 });
        if (p.pitching)
          pitching.push({ ...pl(3, 20, { h: 15, er: 15, bb: 5 }), playerId: p.id, gameId: g.id, teamId: T1 });
      }
  }
  return {
    league: { id: LEAGUE, name: "Synthetic Fall League" },
    season: { id: SEASON, year: 2026, name: "Arizona Fall League 2026" },
    teams: [
      { id: T1, name: "Synthetic Saguaros", abbreviation: "SSG" },
      { id: T2, name: "Fixture Javelinas", abbreviation: "FJV" },
    ],
    organizations: [{ id: ORG, name: "Example Parent Club", abbreviation: "EPC" }],
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      primaryPosition: p.position ?? (p.batting ? "SS" : "P"),
      secondaryPosition: null,
      bats: null,
      throws: null,
      birthDate: null,
      height: null,
      weight: null,
    })),
    games,
    rosterStints: [],
    batting,
    pitching,
    lastIngestedAt: null,
  };
}

const cycle = <T>(xs: T[]) => (d: number) => xs[d % xs.length];
/** Blend of cycles: picks pattern by day so the season mix is stable over time. */
const mix = (pattern: BatLine[][]) => (d: number) => pattern[d % pattern.length][Math.floor(d / pattern.length) % 3];

export const IDS = {
  improver: u(31),
  spike: u(32),
  star: u(33),
  decliner: u(34),
  newcomer: u(35),
  twoWay: u(36),
  tiny: u(37),
  pImprover: u(41),
  pDecliner: u(42),
  pSteady: u(43),
};

/** A population with distinct, known trajectories plus stable filler players. */
export function trajectorySnapshot(days = 27) {
  const fillers: SyntheticPlayer[] = Array.from({ length: 10 }, (_, i) => ({
    id: u(200 + i),
    name: `Filler Hitter ${String.fromCharCode(65 + i)}`,
    batting: mix(
      [
        [WEAK, MID, STRONG],
        [WEAK, WEAK, MID],
        [MID, MID, STRONG],
        [STRONG, STRONG, MID],
        [WEAK, MID, MID],
      ][i % 5],
    ),
  }));
  const pitcherFillers: SyntheticPlayer[] = Array.from({ length: 9 }, (_, i) => ({
    id: u(300 + i),
    name: `Filler Arm ${String.fromCharCode(65 + i)}`,
    pitching: (d: number) =>
      (d + i) % 3 === 0 ? (i % 2 ? P_STRONG : P_WEAK)[d % 2] : null,
  }));
  const players: SyntheticPlayer[] = [
    {
      id: IDS.improver,
      name: "Steady Improver",
      // Progressive: weak → average → strong.
      batting: (d) => (d < 9 ? WEAK : d < 18 ? MID : STRONG)[d % 3],
    },
    {
      id: IDS.spike,
      name: "Late Spike",
      batting: (d) => (d < days - 4 ? WEAK : STRONG)[d % 3],
    },
    { id: IDS.star, name: "Steady Star", batting: cycle(STRONG) },
    {
      id: IDS.decliner,
      name: "Late Decliner",
      batting: (d) => (d < 13 ? STRONG : WEAK)[d % 3],
    },
    {
      id: IDS.newcomer,
      name: "Late Arrival",
      batting: (d) => (d >= days - 10 ? STRONG[d % 3] : null),
    },
    {
      id: IDS.tiny,
      name: "Tiny Sample",
      // Plays rarely: weak early, one strong game late.
      batting: (d) => (d === 2 || d === 5 || d === 8 ? WEAK[0] : d === days - 1 ? STRONG[1] : null),
    },
    {
      id: IDS.twoWay,
      name: "Two Way",
      batting: (d) => (d < 13 ? WEAK : STRONG)[d % 3],
      pitching: (d) => (d % 4 === 0 ? (d < 13 ? P_STRONG : P_WEAK)[d % 2] : null),
    },
    {
      id: IDS.pImprover,
      name: "Arm Improver",
      pitching: (d) => (d % 2 === 0 ? (d < 13 ? P_WEAK : P_STRONG)[(d / 2) % 2] : null),
    },
    {
      id: IDS.pDecliner,
      name: "Arm Decliner",
      pitching: (d) => (d % 2 === 1 ? (d < 13 ? P_STRONG : P_WEAK)[((d - 1) / 2) % 2] : null),
    },
    {
      id: IDS.pSteady,
      name: "Arm Steady",
      pitching: (d) => (d % 2 === 0 ? P_STRONG[(d / 2) % 2] : null),
    },
    ...fillers,
    ...pitcherFillers,
  ];
  return syntheticSnapshot(players, days);
}

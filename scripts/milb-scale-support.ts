/**
 * Clearly fictional, deterministic MiLB-level-scale snapshots for analytics/integration tests and
 * benchmarks. Internal-style UUIDs only; no provider IDs, no real players or clubs.
 */
import type {
  AflBattingLine,
  AflPitchingLine,
  AflSnapshot,
} from "../src/services/afl/types";
import type { MilbLevelId } from "../src/domain/levels";

const uid = (ns: number, n: number) =>
  `00000000-0000-4000-${String(9000 + ns).padStart(4, "0")}-${String(n).padStart(12, "0")}`;

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ScaleOptions {
  /** Namespace keeps UUIDs distinct between levels while letting tests share player IDs. */
  ns: number;
  level?: MilbLevelId;
  teams?: number;
  /** Season day count starting at `start` (one game per team per day, rest days skipped). */
  days?: number;
  start?: string;
  year?: number;
  seed?: number;
  /** Player IDs (from playerId()) to include on team 0 regardless of namespace. */
  sharedPlayers?: { id: string; name: string; fromDay?: number; toDay?: number; role: "hitter" | "pitcher" }[];
}

export const playerId = (ns: number, n: number) => uid(ns, 100000 + n);

export function scaleSnapshot(o: ScaleOptions): AflSnapshot {
  const year = o.year ?? 2026;
  const teamsN = o.teams ?? 30;
  const days = o.days ?? 165;
  const start = o.start ?? `${year}-04-01`;
  const r = rng(o.seed ?? 7);
  const teams = Array.from({ length: teamsN }, (_, i) => ({
    id: uid(o.ns, 1000 + i),
    name: `Fictional Club ${o.ns}-${i}`,
    abbreviation: `F${o.ns}${i}`.slice(0, 4),
  }));
  const organizations = teams.map((_, i) => ({
    id: uid(0, 5000 + i), // shared parent orgs across levels
    name: `Fictional Org ${i}`,
    abbreviation: `O${i}`,
  }));
  const players: AflSnapshot["players"] = [];
  const roster = teams.map((t, ti) => {
    const hitters: string[] = [],
      pitchers: string[] = [];
    for (let k = 0; k < 13; k++) {
      const id = playerId(o.ns, ti * 100 + k);
      hitters.push(id);
      players.push({
        id,
        name: `Hitter ${o.ns}-${ti}-${k}`,
        primaryPosition: ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "DH"][k % 9],
        secondaryPosition: null,
        bats: "R",
        throws: "R",
        birthDate: `${2000 + (k % 6)}-05-0${1 + (k % 9)}`,
        height: null,
        weight: null,
      });
    }
    for (let k = 0; k < 13; k++) {
      const id = playerId(o.ns, ti * 100 + 50 + k);
      pitchers.push(id);
      players.push({
        id,
        name: `Pitcher ${o.ns}-${ti}-${k}`,
        primaryPosition: "P",
        secondaryPosition: null,
        bats: "R",
        throws: k % 3 ? "R" : "L",
        birthDate: `${1999 + (k % 6)}-08-1${k % 9}`,
        height: null,
        weight: null,
      });
    }
    return { team: t, hitters, pitchers };
  });
  for (const sp of o.sharedPlayers ?? [])
    players.push({
      id: sp.id,
      name: sp.name,
      primaryPosition: sp.role === "pitcher" ? "P" : "SS",
      secondaryPosition: null,
      bats: "L",
      throws: "R",
      birthDate: "2003-03-03",
      height: null,
      weight: null,
    });
  const games: AflSnapshot["games"] = [];
  const batting: AflBattingLine[] = [];
  const pitching: AflPitchingLine[] = [];
  const startMs = Date.parse(`${start}T00:00:00Z`);
  let gameN = 0;
  for (let d = 0; d < days; d++) {
    if (d % 7 === 0) continue; // weekly off day
    const date = new Date(startMs + d * 86400000).toISOString().slice(0, 10);
    for (let i = 0; i + 1 < teamsN; i += 2) {
      const a = (i + d) % teamsN,
        b = (i + 1 + d * 3) % teamsN === a ? (a + 1) % teamsN : (i + 1 + d * 3) % teamsN;
      const home = roster[a],
        away = roster[b];
      const gameId = uid(o.ns, 2_000_000 + gameN++);
      const hs = Math.floor(r() * 9),
        as = Math.floor(r() * 9);
      games.push({
        id: gameId,
        date,
        startsAt: `${date}T19:05:00.000Z`,
        status: "final",
        homeTeamId: home.team.id,
        awayTeamId: away.team.id,
        homeScore: hs,
        awayScore: as === hs ? as + 1 : as,
        venue: null,
        boxscoreComplete: true,
      });
      for (const side of [home, away]) {
        const lineup = side.hitters.slice(d % 4, (d % 4) + 9);
        if (side === roster[0])
          for (const sp of o.sharedPlayers ?? [])
            if (sp.role === "hitter" && d >= (sp.fromDay ?? 0) && d <= (sp.toDay ?? days)) lineup.push(sp.id);
        for (const pid of lineup) {
          const pa = 3 + Math.floor(r() * 3);
          const bb = r() < 0.1 ? 1 : 0;
          const ab = pa - bb;
          const h = Math.min(ab, Math.floor(r() * 2.2));
          const hr = h && r() < 0.15 ? 1 : 0;
          const dbl = h > hr && r() < 0.25 ? 1 : 0;
          batting.push({
            playerId: pid,
            gameId,
            teamId: side.team.id,
            plateAppearances: pa,
            atBats: ab,
            hits: h,
            doubles: dbl,
            triples: 0,
            homeRuns: hr,
            walks: bb,
            strikeouts: Math.min(ab - h, Math.floor(r() * 2.5)),
            hitByPitch: 0,
            sacrificeFlies: 0,
            stolenBases: r() < 0.05 ? 1 : 0,
            runs: h ? 1 : 0,
            rbi: hr,
            caughtStealing: 0,
          });
        }
        const staff = [side.pitchers[d % 5], side.pitchers[5 + (d % 8)]];
        if (side === roster[0])
          for (const sp of o.sharedPlayers ?? [])
            if (sp.role === "pitcher" && d % 5 === 0 && d >= (sp.fromDay ?? 0) && d <= (sp.toDay ?? days)) staff.push(sp.id);
        for (const [k, pid] of staff.entries()) {
          const outs = k === 0 ? 12 + Math.floor(r() * 7) : 3 + Math.floor(r() * 4);
          const h = Math.floor(r() * (outs / 3));
          const bb = Math.floor(r() * 2);
          pitching.push({
            playerId: pid,
            gameId,
            teamId: side.team.id,
            outsRecorded: outs,
            battersFaced: outs + h + bb,
            hitsAllowed: h,
            earnedRuns: Math.floor(h / 2),
            walks: bb,
            strikeouts: Math.floor(r() * (outs / 2)),
            homeRunsAllowed: 0,
            runs: Math.floor(h / 2),
            hitBatters: 0,
            pitches: outs * 5,
          });
        }
      }
    }
  }
  const observed = `${year}-09-30T12:00:00.000Z`;
  const rosterStints = roster.flatMap((t, ti) =>
    [...t.hitters, ...t.pitchers].map((pid) => ({
      playerId: pid,
      teamId: t.team.id,
      organizationId: organizations[ti].id,
      rosterStatus: "A",
      firstObservedAt: observed,
      lastObservedAt: observed,
    })),
  );
  const levelLabel = o.level ?? "aaa";
  return {
    league: { id: uid(o.ns, 1), name: levelLabel },
    scope: { kind: "milb-level", level: levelLabel, leagueIds: [uid(o.ns, 2)] },
    season: { id: uid(0, 3), year, name: `${year} MiLB season` },
    teams,
    organizations,
    players,
    games,
    rosterStints,
    batting,
    pitching,
    lastIngestedAt: `${year}-10-01T00:00:00.000Z`,
  };
}

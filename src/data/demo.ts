/**
 * FICTIONAL FIXTURES — not used by any user-facing route.
 *
 * Kept only for the automated tests (scripts/foundation.test.ts, scripts/discovery.test.ts) and
 * the explicit opt-in development seed (scripts/seed.ts). Every player, organization, team,
 * statistic and story here is invented. Do not import this module from src/app or src/components.
 */
import type {
  Player,
  Team,
  NewsItem,
  Position,
  Organization,
  DevelopmentContext,
  BattingStats,
  PitchingStats,
  TimeWindow,
  PlayerTeamMembership,
  PlayerOrganizationMembership,
  RankingMode,
} from "@/types/baseball";

/** FICTIONAL fixtures only. No player, organization, transaction, or score is real. */
export const DEMO_SEASON = 2026;
export const DEMO_AS_OF = "2026-10-24";
export const demoId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const organizations: Organization[] = [
  { id: demoId(401), name: "Northstar Navigators", abbreviation: "NSN" },
  { id: demoId(402), name: "Copper State Copperheads", abbreviation: "CSC" },
  { id: demoId(403), name: "Cobalt Bay Captains", abbreviation: "CBC" },
];
export const contexts: DevelopmentContext[] = [
  {
    id: demoId(501),
    slug: "aaa",
    name: "Triple-A",
    shortName: "AAA",
    kind: "level",
  },
  {
    id: demoId(502),
    slug: "aa",
    name: "Double-A",
    shortName: "AA",
    kind: "level",
  },
  {
    id: demoId(503),
    slug: "high-a",
    name: "High-A",
    shortName: "High-A",
    kind: "level",
  },
  {
    id: demoId(504),
    slug: "single-a",
    name: "Single-A",
    shortName: "Single-A",
    kind: "level",
  },
  {
    id: demoId(505),
    slug: "rookie",
    name: "Rookie / Complex",
    shortName: "Rookie",
    kind: "level",
  },
  {
    id: demoId(506),
    slug: "afl",
    name: "Arizona Fall League",
    shortName: "AFL",
    kind: "league",
  },
];
const teamDefinitions: [string, string, number, number | null][] = [
  ["Northstar Comets", "NCO", 0, 0],
  ["Copper Valley Foxes", "CVF", 1, 1],
  ["Cobalt Coast Tides", "CCT", 2, 2],
  ["Redwood Mesa Owls", "RMO", 3, 0],
  ["Juniper Ridge Pilots", "JRP", 0, 1],
  ["Silver Basin Miners", "SBM", 1, 2],
  ["Canyon Creek Moths", "CCM", 4, 1],
  ["Mesa Lanterns", "MLN", 5, null],
  ["Saguaro Starlings", "SST", 5, null],
  ["Pine Harbor Kestrels", "PHK", 2, 0],
  ["Aurora Sound Terns", "AST", 1, 0],
  ["Copper Hills Fireflies", "CHF", 2, 1],
  ["Desert Run Jackrabbits", "DRJ", 3, 1],
];
export const teams: Team[] = teamDefinitions.map(
  ([name, abbreviation, context, org], i) => ({
    id: demoId(101 + i),
    name,
    abbreviation,
    contextId: contexts[context].id,
    organizationId: org === null ? null : organizations[org].id,
  }),
);
const names = [
  "Atlas Finch",
  "Orion Vale",
  "Jett Marlow",
  "Caspian Reed",
  "Briar Sterling",
  "Zephyr Knox",
  "Flint Alder",
  "Indigo Pike",
  "Rune Calder",
  "Cedar Voss",
  "Onyx Bell",
  "Arlo Quill",
  "Soren Dune",
  "Cosmo Wren",
  "Elio Frost",
  "Jasper Cove",
  "Rowan Slate",
  "Phoenix Moss",
];
const positions: Position[] = [
  "SS",
  "RHP",
  "CF",
  "1B",
  "LHP",
  "C",
  "3B",
  "RHP / DH",
  "RF",
  "RHP",
  "2B",
  "LF",
  "LHP",
  "SS",
  "CF",
  "RHP",
  "C",
  "1B",
];
const grades = [
  92, 89, 87, 85, 84, 83, 81, 80, 79, 78, 77, 76, 75, 74, 73, 72, 71, 70,
];
const momenta = [
  8.4, 6.2, 5.8, -2.6, 4.1, 7.2, -3.8, 5.1, 2.4, -1.9, 3.3, -4.2, 1.6, 2.8,
  -1.4, 4.6, 0.8, -2.1,
];

const dates = [
  "2026-09-19",
  "2026-09-26",
  "2026-10-03",
  "2026-10-10",
  "2026-10-17",
  DEMO_AS_OF,
];
// Explicit fictional counting-stat snapshots. Windows are not calculated from game logs.
// AB, H, 2B, 3B, HR, BB, SO, SB. These are baseball counts, never ranking weights.
const battingFixtures: Record<TimeWindow, number[][]> = {
  "7d": [
    [22, 10, 2, 0, 3, 4, 3, 2],
    [24, 9, 2, 1, 2, 3, 5, 1],
    [20, 6, 1, 0, 1, 5, 4, 0],
    [23, 5, 1, 0, 0, 2, 8, 1],
    [21, 12, 3, 0, 4, 4, 3, 3],
    [19, 7, 2, 0, 2, 3, 4, 2],
  ],
  "14d": [
    [46, 19, 4, 0, 5, 8, 7, 3],
    [48, 18, 4, 1, 3, 7, 9, 2],
    [43, 14, 3, 0, 2, 9, 8, 1],
    [47, 10, 2, 0, 1, 4, 15, 1],
    [44, 22, 5, 1, 6, 8, 6, 5],
    [40, 16, 3, 0, 4, 7, 7, 3],
  ],
  "30d": [
    [98, 34, 7, 1, 8, 16, 19, 5],
    [100, 36, 8, 1, 6, 15, 21, 4],
    [92, 27, 5, 0, 4, 18, 20, 2],
    [96, 22, 4, 0, 2, 9, 31, 2],
    [94, 39, 8, 2, 9, 15, 18, 8],
    [88, 30, 6, 1, 6, 14, 19, 5],
  ],
  season: [
    [320, 101, 20, 2, 19, 48, 62, 15],
    [340, 106, 23, 3, 18, 45, 72, 12],
    [310, 85, 17, 1, 12, 51, 66, 7],
    [330, 79, 16, 1, 9, 34, 92, 8],
    [300, 100, 21, 3, 20, 44, 59, 22],
    [290, 94, 19, 2, 17, 42, 63, 14],
  ],
};
// Outs, earned runs, hits allowed, strikeouts, walks.
const pitchingFixtures: Record<TimeWindow, number[][]> = {
  "7d": [
    [21, 1, 4, 11, 1],
    [18, 2, 5, 9, 2],
    [15, 0, 2, 8, 1],
    [18, 5, 8, 5, 4],
  ],
  "14d": [
    [39, 2, 8, 21, 3],
    [36, 4, 10, 18, 4],
    [33, 1, 5, 17, 2],
    [36, 9, 16, 11, 7],
  ],
  "30d": [
    [78, 5, 18, 39, 7],
    [75, 9, 22, 35, 9],
    [69, 4, 14, 32, 6],
    [72, 16, 29, 24, 13],
  ],
  season: [
    [303, 28, 75, 136, 28],
    [318, 37, 91, 127, 33],
    [285, 24, 68, 119, 25],
    [294, 49, 108, 99, 44],
  ],
};
function battingLine(row: number[]): BattingStats {
  const [
    atBats,
    hits,
    doubles,
    triples,
    homeRuns,
    walks,
    strikeouts,
    stolenBases,
  ] = row;
  return {
    atBats,
    hits,
    doubles,
    triples,
    homeRuns,
    walks,
    strikeouts,
    stolenBases,
    hitByPitch: 0,
    sacrificeFlies: 0,
  };
}
function pitchingLine(row: number[]): PitchingStats {
  const [outsRecorded, earnedRuns, hitsAllowed, strikeouts, walks] = row;
  return { outsRecorded, earnedRuns, hitsAllowed, strikeouts, walks };
}
// Explicit sample selections keep the fictional hot/cold examples coherent.
const battingSamples = [0, 1, 4, 3, 4, 5, 3, 1, 0, 3, 4, 3, 0, 1, 3, 3, 4, 3];
const pitchingSamples = [0, 1, 2, 3, 0, 1, 2, 2, 0, 3, 2, 3, 0, 1, 2, 0, 0, 3];
const teamIndices = [1, 0, 3, 4, 5, 7, 2, 8, 6, 5, 9, 3, 6, 10, 2, 0, 8, 4];
const aflOrganizations: Record<number, number> = { 5: 1, 7: 2, 16: 0 };
export const players: Player[] = names.map((name, i) => {
  const team = teams[teamIndices[i]];
  const pitcher = positions[i].includes("HP");
  const twoWay = positions[i] === "RHP / DH";
  const performance = Object.fromEntries(
    (["7d", "14d", "30d", "season"] as TimeWindow[]).map((window) => [
      window,
      {
        ...(!pitcher || twoWay
          ? { batting: battingLine(battingFixtures[window][battingSamples[i]]) }
          : {}),
        ...(pitcher
          ? {
              pitching: pitchingLine(
                pitchingFixtures[window][pitchingSamples[i]],
              ),
            }
          : {}),
      },
    ]),
  ) as Player["performance"];
  // AFL season means the current AFL stint only, not a combined regular + fall season.
  if (team.contextId === contexts[5].id)
    performance.season = { ...performance["30d"] };
  const history = dates.map((date, j) => ({
    date,
    grade: Math.round((grades[i] - (momenta[i] * (5 - j)) / 5) * 10) / 10,
    momentum: Math.round(((momenta[i] * (j + 1)) / 6) * 10) / 10,
  }));
  const seasonStats = [
    { season: 2026, teamId: team.id, ...performance.season },
  ];
  if (team.contextId === contexts[5].id)
    seasonStats.unshift({
      season: 2026,
      teamId: teams[i === 5 ? 1 : i === 7 ? 5 : 10].id,
      ...performance["season"],
      ...(!pitcher || twoWay
        ? { batting: battingLine(battingFixtures.season[battingSamples[i]]) }
        : {}),
      ...(pitcher
        ? {
            pitching: pitchingLine(pitchingFixtures.season[pitchingSamples[i]]),
          }
        : {}),
    });
  return {
    id: demoId(i + 1),
    name,
    teamId: team.id,
    organizationId:
      team.organizationId ?? organizations[aflOrganizations[i]].id,
    position: positions[i],
    birthDate: `${[2006, 2003, 2007, 2002, 2004, 2005, 2006, 2004, 2008, 2003, 2006, 2005, 2007, 2005, 2006, 2002, 2005, 2003][i]}-04-12`,
    bats: i % 3 === 0 ? "L" : "R",
    throws: positions[i] === "LHP" ? "L" : "R",
    grade: grades[i],
    momentum: momenta[i],
    history,
    performance,
    seasonStats,
    ...performance.season,
    note:
      i === 0
        ? "Fictional watch note: 19 hits and five home runs in the 14-day sample at Double-A. The demo ordering puts this higher-level performance near the top; it is not a model-generated evaluation."
        : "Fictional editorial watch note. Explore the selected-window statistics and assignment history below. Grade and Momentum are illustrative values; evidence-backed explanations will follow verified data ingestion.",
  };
});
/** Independent organization history persists while an affiliate or AFL assignment changes. */
export const organizationMemberships: PlayerOrganizationMembership[] =
  players.map((p) => ({
    playerId: p.id,
    organizationId: p.organizationId,
    startsOn: "2024-01-01",
    endsOn: null,
  }));
export const memberships: PlayerTeamMembership[] = players.flatMap(
  (p, i): PlayerTeamMembership[] => {
    const current = {
      id: demoId(1001 + i * 4),
      playerId: p.id,
      teamId: p.teamId,
      season: 2026,
      startsOn: "2026-04-01",
      endsOn: null,
      assignmentType: "assignment" as const,
    };
    if ([5, 7, 16].includes(i)) {
      const base = teams[i === 5 ? 1 : i === 7 ? 5 : 10];
      return [
        {
          ...current,
          id: demoId(1002 + i * 4),
          teamId: base.id,
          startsOn: "2026-04-01",
          endsOn: null,
        },
        {
          ...current,
          startsOn: "2026-10-01",
          assignmentType: "afl-assignment" as const,
        },
      ];
    }
    if (i === 0)
      return [
        {
          ...current,
          id: demoId(1002),
          teamId: teams[12].id,
          season: 2024,
          startsOn: "2024-04-01",
          endsOn: "2024-09-20",
        },
        {
          ...current,
          id: demoId(1003),
          teamId: teams[11].id,
          season: 2025,
          startsOn: "2025-04-01",
          endsOn: "2025-09-20",
        },
        {
          ...current,
          startsOn: "2026-08-16",
          assignmentType: "promotion" as const,
        },
      ];
    if (i === 13)
      return [
        {
          ...current,
          id: demoId(1054),
          teamId: teams[9].id,
          startsOn: "2026-04-01",
          endsOn: "2026-09-29",
        },
        {
          ...current,
          startsOn: "2026-09-30",
          assignmentType: "promotion" as const,
        },
      ];
    return [current];
  },
);
export const news: NewsItem[] = [
  {
    id: "demo-news-1",
    title: "Finch’s Double-A stretch keeps him on the watchlist",
    summary:
      "Nineteen hits and five home runs in an invented 14-day sample put Atlas Finch in focus. All performance and evaluations are fictional.",
    category: "Performance",
    date: "2026-10-24",
    playerIds: [players[0].id],
    teamIds: [players[0].teamId],
    organizationIds: [players[0].organizationId],
  },
  {
    id: "demo-news-2",
    title: "Fall assignment: Knox joins the Mesa Lanterns",
    summary:
      "A fictional AFL assignment gives Zephyr Knox another development setting. His Copper State organization membership remains unchanged.",
    category: "Fall league",
    date: "2026-10-23",
    playerIds: [players[5].id],
    teamIds: [players[5].teamId],
    organizationIds: [players[5].organizationId],
  },
  {
    id: "demo-news-3",
    title: "Moss works through a quieter stretch with the Pilots",
    summary:
      "A development story beyond the leaderboard leaders. Phoenix Moss’s fictional recent sample illustrates why the news feed covers more than hot players.",
    category: "Development",
    date: "2026-10-22",
    playerIds: [players[17].id],
    teamIds: [players[17].teamId],
    organizationIds: [players[17].organizationId],
  },
  {
    id: "demo-news-4",
    title: "Wren moves up to Double-A with Aurora Sound",
    summary:
      "An invented September 30 promotion connects the Kestrels and Terns chapters of Cosmo Wren’s development history.",
    category: "Promotion",
    date: "2026-09-30",
    playerIds: [players[13].id],
    teamIds: [teams[9].id, teams[10].id],
    organizationIds: [players[13].organizationId],
  },
];
/** Hand-authored editorial fixture orders, NOT scores, weights, or ranking algorithms.
 * Different windows have independent orders. Never infer a methodology from these arrays. */
export const demoDiscoveryOrder: Record<
  TimeWindow,
  Record<RankingMode, string[]>
> = Object.fromEntries(
  Object.entries({
    "7d": {
      priority: [1, 0, 4, 15, 13, 5, 7, 2, 8, 16, 10, 12, 3, 6, 9, 14, 11, 17],
      performance: [
        8, 2, 12, 1, 5, 7, 0, 4, 10, 16, 13, 15, 3, 6, 14, 9, 11, 17,
      ],
    },
    "14d": {
      priority: [0, 1, 4, 15, 13, 5, 7, 2, 8, 16, 10, 12, 3, 6, 9, 14, 11, 17],
      performance: [
        2, 8, 5, 1, 7, 0, 12, 4, 10, 16, 13, 15, 3, 6, 14, 9, 11, 17,
      ],
    },
    "30d": {
      priority: [4, 0, 1, 13, 15, 7, 5, 2, 10, 8, 16, 12, 3, 9, 6, 14, 11, 17],
      performance: [
        5, 2, 8, 7, 0, 1, 4, 12, 16, 10, 13, 15, 3, 6, 9, 14, 17, 11,
      ],
    },
    season: {
      priority: [1, 0, 4, 15, 13, 5, 7, 2, 10, 16, 8, 12, 3, 6, 9, 14, 17, 11],
      performance: [
        8, 2, 0, 1, 5, 7, 4, 10, 12, 16, 13, 15, 3, 6, 9, 14, 11, 17,
      ],
    },
  }).map(([window, orders]) => [
    window,
    {
      priority: orders.priority.map((i) => demoId(i + 1)),
      performance: orders.performance.map((i) => demoId(i + 1)),
    },
  ]),
) as Record<TimeWindow, Record<RankingMode, string[]>>;

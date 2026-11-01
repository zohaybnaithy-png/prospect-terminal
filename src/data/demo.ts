import type { Player, Team, NewsItem, Position } from "@/types/baseball";

/** Entire dataset is fictional, deterministic, and for interface development only.
 * These hand-authored scores are NOT an analytics model or real scouting grades. */
export const DEMO_SEASON = 2026;
export const DEMO_AS_OF = "2026-04-18";
export const teams: Team[] = [
  {
    id: "00000000-0000-4000-8000-000000000101",
    name: "Northstar Tech Comets",
    abbreviation: "NTC",
    conference: "Aurora Conference",
    level: "NCAA D1",
    color: "mint",
  },
  {
    id: "00000000-0000-4000-8000-000000000102",
    name: "Copper Valley Foxes",
    abbreviation: "CVF",
    conference: "Aurora Conference",
    level: "NCAA D1",
    color: "amber",
  },
  {
    id: "00000000-0000-4000-8000-000000000103",
    name: "Cobalt Coast Tides",
    abbreviation: "CCT",
    conference: "Horizon Conference",
    level: "NCAA D1",
    color: "blue",
  },
  {
    id: "00000000-0000-4000-8000-000000000104",
    name: "Redwood Mesa Owls",
    abbreviation: "RMO",
    conference: "Horizon Conference",
    level: "NCAA D1",
    color: "purple",
  },
];
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
  "2026-03-14",
  "2026-03-21",
  "2026-03-28",
  "2026-04-04",
  "2026-04-11",
  DEMO_AS_OF,
];
export const players: Player[] = names.map((name, i) => {
  const pitcher = positions[i].includes("HP");
  const twoWay = positions[i] === "RHP / DH";
  const history = dates.map((date, j) => ({
    date,
    grade: Math.round((grades[i] - (momenta[i] * (5 - j)) / 5) * 10) / 10,
    momentum: Math.round(((momenta[i] * (j + 1)) / 6) * 10) / 10,
  }));
  return {
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    name,
    teamId: teams[i % 4].id,
    position: positions[i],
    year: ["Junior", "Sophomore", "Freshman"][i % 3],
    bats: i % 3 === 0 ? "L" : "R",
    throws: positions[i] === "LHP" ? "L" : "R",
    grade: grades[i],
    momentum: momenta[i],
    history,
    ...(!pitcher || twoWay
      ? {
          batting: {
            atBats: 100 + i * 3,
            hits: 38 + i,
            homeRuns: Math.max(2, 12 - (i % 8)),
            walks: 22 - (i % 7),
            strikeouts: 18 + i,
            stolenBases: 14 - (i % 10),
          },
        }
      : {}),
    ...(pitcher
      ? {
          pitching: {
            outsRecorded: 120 + i * 3,
            earnedRuns: 10 + i,
            strikeouts: 65 + i * 2,
            walks: 10 + i,
          },
        }
      : {}),
    note:
      i === 0
        ? "Demo narrative: improved contact quality and a patient approach are the story in this fictional six-week sample. A future model will explain verified changes with source-backed evidence."
        : "Fictional scouting note for interface development. Score movement is illustrative; no evaluation algorithm has been implemented.",
  };
});
export const news: NewsItem[] = [
  {
    id: "demo-news-1",
    title: "Finch finds another gear in the Comets’ lineup",
    summary:
      "A fictional weekend series puts Northstar Tech’s shortstop in our demo spotlight.",
    category: "Player watch",
    date: "2026-04-18",
    playerIds: [players[0].id],
  },
  {
    id: "demo-news-2",
    title: "Vale and Knox headline the weekly watchlist",
    summary:
      "An illustrative look at two contrasting player profiles in the development dataset.",
    category: "Watchlist",
    date: "2026-04-17",
    playerIds: [players[1].id, players[5].id],
  },
  {
    id: "demo-news-3",
    title: "Around the Aurora: a new season takes shape",
    summary:
      "Fictional conference notes from the Comets and Foxes. All teams and events are invented.",
    category: "Conference report",
    date: "2026-04-16",
    playerIds: [players[0].id, players[1].id],
  },
];

/** Presentation-only fictional editorial fixtures. No real scores, imagery, or media feeds. */
import { demoId } from "./demo";
export interface DemoGame {
  id: string;
  context: string;
  awayTeamId: string;
  homeTeamId: string;
  awayScore: number | null;
  homeScore: number | null;
  status: string;
}
export const demoGames: DemoGame[] = [
  {
    id: "demo-game-1",
    context: "aaa",
    awayTeamId: demoId(101),
    homeTeamId: demoId(105),
    awayScore: 4,
    homeScore: 3,
    status: "Final",
  },
  {
    id: "demo-game-2",
    context: "aa",
    awayTeamId: demoId(102),
    homeTeamId: demoId(106),
    awayScore: 6,
    homeScore: 2,
    status: "Final",
  },
  {
    id: "demo-game-3",
    context: "high-a",
    awayTeamId: demoId(103),
    homeTeamId: demoId(110),
    awayScore: 1,
    homeScore: 1,
    status: "Bot 7 · Demo",
  },
  {
    id: "demo-game-4",
    context: "single-a",
    awayTeamId: demoId(104),
    homeTeamId: demoId(113),
    awayScore: null,
    homeScore: null,
    status: "7:05 PM · Demo",
  },
  {
    id: "demo-game-5",
    context: "afl",
    awayTeamId: demoId(108),
    homeTeamId: demoId(109),
    awayScore: 5,
    homeScore: 7,
    status: "Final",
  },
];
export const homeHeadlines = [
  {
    newsId: "demo-news-1",
    image: "/demo/at-bat.svg",
    alt: "Original demo illustration of a hitter at a baseball field",
    teaser:
      "A closer look at the shortstop’s recent Double-A stretch, and the next chapter in his development.",
  },
  {
    newsId: "demo-news-2",
    image: "/demo/fall-field.svg",
    alt: "Original demo illustration of a fall-league baseball field",
    teaser:
      "A new setting, the same organization. Follow Knox’s fictional fall assignment with the Lanterns.",
  },
];
export interface DemoHighlight {
  id: string;
  playerId: string;
  title: string;
  description: string;
  image: string;
  alt: string;
  date: string;
}
export const demoHighlights: DemoHighlight[] = [
  {
    id: "demo-highlight-1",
    playerId: demoId(1),
    title: "Finch turns on a fastball",
    description:
      "A fictional home-run storyboard. Original illustration only; no game footage is available.",
    image: "/demo/at-bat.svg",
    alt: "Demo illustration of a hitter finishing a swing",
    date: "2026-10-24",
  },
  {
    id: "demo-highlight-2",
    playerId: demoId(2),
    title: "Vale works the outside corner",
    description:
      "A fictional pitching storyboard. Original illustration only; no game footage is available.",
    image: "/demo/on-the-mound.svg",
    alt: "Demo illustration of a pitcher delivering toward home plate",
    date: "2026-10-23",
  },
  {
    id: "demo-highlight-3",
    playerId: demoId(6),
    title: "A fresh start in fall ball",
    description:
      "A fictional fall-league storyboard featuring Knox. Original illustration only; no game footage is available.",
    image: "/demo/fall-field.svg",
    alt: "Demo illustration of a baseball diamond and fall-league stands",
    date: "2026-10-22",
  },
];

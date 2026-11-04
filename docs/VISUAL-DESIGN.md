# Light editorial homepage

> **Historical.** This describes a previous demo-era phase. Showcase V1 removed the fictional homepage content, demo routes and demo profiles; see the README "Current status" section.

This focused visual phase retains the MiLB-first product, stable players, organization/affiliate and AFL relationships, development timelines, detailed discovery modes, Data, and Screener. No backend contract, schema, migration, seed, scoring methodology, ingestion client, or application dependency changed.

## Front-page composition

The homepage is an editorial entry point rather than a leaderboard or research form. Its short white header combines the PT wordmark, “Track baseball’s next generation,” and prominent player/team search. A compact horizontal navigation and fictional MiLB/AFL game strip follow. A short demo disclosure remains visible.

The desktop content uses approximately 72% editorial space and 28% prospect intelligence. Two illustrated lead stories anchor the main area, followed by three compact highlight previews and two recorded demo call-ups. The sidebar contains five Trending Prospects and five Top Prospects. More news follows below this initial hook. There is no marketing hero, metric-tile grid, sidebar navigation, or full research filter panel on the homepage.

The shared visual system uses white/off-white backgrounds, charcoal text, muted gray secondary information, thin light-gray borders, restrained teal links, and compact system sans-serif typography with a condensed system-font stack for headings. Statistical numbers retain tabular alignment. Inner-page tables, controls, player tabs, and Recharts trajectories inherit the light theme without changing their behavior. No external font or asset service is required.

## Content and demo boundaries

- **Trending Prospects:** Existing priority-mode fixture ordering, defaulting to 14D/all levels. Small 7D/14D/30D and context controls select the existing fictional window samples. Batting slash lines and pitching ERA/K summaries are descriptive baseball statistics; Momentum remains an illustrative snapshot value. Full ranking-mode and screener controls remain on the inner routes.
- **Top Prospects:** A separate five-player list sorted by existing illustrative overall Prospect Grade, distinct from recent-performance ordering.
- **Headlines:** Existing fictional news stories with concise editorial teasers and linked players. Stories open the chronological News page at the appropriate article.
- **Highlights:** Three explicitly fictional storyboards with an original local illustration, preview indicator, linked player, and team. `/highlights` opens a useful preview page and explicitly states that no playable footage exists. No copyrighted video or external embed is used.
- **Call-ups:** Existing fictional affiliate promotions from dated player/team memberships, linked to the same player profiles. Dates and prior/current levels are shown. They are labeled as the latest recorded demo movements; no unsupported MLB promotion or membership is invented.
- **Score strip:** Five fictional games across AAA, AA, High-A, Single-A, and AFL, with team/level links, scores or scheduled status, and the fixed demo snapshot date. It is a presentation fixture, not a live game feed. Narrow screens scroll horizontally.

`src/data/demo-home.ts` isolates editorial/scoreboard presentation fixtures. `public/demo/*.svg` contains original vector baseball scenes authored for this project. They are demo artwork, not real player photographs, article assets, or game footage. No MLB/Savant branding, logos, article copy, or proprietary imagery was copied or scraped.

## Viewport review

Inspected the running production app with Chromium at 100% zoom. A compact-height desktop media query reduces header spacing and image heights for laptops while keeping larger-screen imagery more spacious. Every core section fits fully in the initial viewport at the three desktop sizes checked:

| Viewport   | Call-ups section bottom | Top Prospects section bottom |
| ---------- | ----------------------- | ---------------------------- |
| 1280 × 720 | 704px                   | 715px                        |
| 1366 × 768 | 704px                   | 715px                        |
| 1440 × 900 | 769px                   | 744px                        |

Screenshots were visually inspected, not just measured. Headlines, baseball artwork, trending players, highlights, top prospects, call-ups, game context, search, and the tagline are visible before scrolling. Mobile at 390px reflows the editorial and sidebar content while retaining horizontal score/table scrolling and no page-level overflow.

## Validation

Type checking, lint, all ten existing tests, and the production build pass. Browser checks cover the first-viewport requirement, loaded images, light inner pages, Trending controls, player/team search/reset, highlight click-through and no-footage messaging, Data sorting/filtering, Screener conditions, AFL organization identity, development sections, chart switching, and mobile overflow/score scrolling. No browser exceptions were observed, and all 51 linked application URLs checked returned HTTP 200. Database/schema/dependency files remain unchanged.

# MiLB-first product redesign review (previous visual phase)

> **Historical.** This describes a previous demo-era phase. Showcase V1 removed the fictional homepage content, demo routes and demo profiles; see the README "Current status" section.

The MiLB/player-development architecture and discovery behavior below are retained. This document records the previous visual phase; the current light editorial homepage and viewport QA are described in [VISUAL-DESIGN.md](VISUAL-DESIGN.md).

## User experience

The homepage opens with “Who’s balling out?” controls and a statistical table. It has no marketing hero, decorative diamond, stock tiles, sparkline grid, neon, gradients, or financial-market framing. A small explanatory paragraph follows the useful content. Charcoal surfaces, restrained blue links, subtle separators, compact tabs, aligned numbers, and horizontal table scrolling follow an original baseball-information design informed by the information-first approach of Baseball Savant/FanGraphs; no branding, assets, or proprietary data are copied.

Default: Prospect Priority / All Levels / 14D / All players. All six developmental contexts and all four windows are selectable. Pure Performance can surface a fictional Single-A player first. Hitter/pitcher modes expose appropriate columns; the two-way player appears in both. Column sorting is explicit and distinct from fixture ranking. Data expands the statistical columns; the Screener adds current available conditions. No unsupported advanced metric is shown.

Organization, affiliate, and league context is one click from player rows. Organization pages provide affiliates, current performers, illustrative risers, movement, and related stories. Level/league pages start with performers. The AFL page includes players from multiple organizations; fall assignments do not replace parent organization identity. Current-team rosters and historical affiliations are labeled separately.

Player profiles keep identity/context and Grade/Momentum compact, then move directly to editorial context and statistics. Anchor tabs connect Overview, Stats, Development, Trends, and News. Two-way profiles show both stat types. AFL profiles retain separate regular and fall team-stint rows. Historical dates without stat coverage do not become fake statistical records. Unavailable game logs, splits, and rankings are marked planned.

News remains chronological and includes development stories about players outside the top discovery positions. Player, team, and organization references link back to the same entities. No fake highlights, real-player metrics, tracking measurements, scouting grades, or ingestion clients were added.

## Demo ordering and windows

The two modes and four windows map to eight explicit ordered ID arrays. Recent numbers are separately authored fictional counting-stat snapshots, not season totals with a new label and not game-log aggregates. A future real adapter replaces these fixture lookups after data/source validation and an independently specified methodology. Grade/Momentum are static snapshot examples, independent from the selected performance window.

## Engineering review

- Retained existing player IDs, Drizzle core entities, historical membership/stat tables, repository abstraction, and database-independent rendering.
- Added only organizations, dated player organization memberships, optional team parent organization, and descriptive assignment type. Migration 0001 is additive; the initial migration is unchanged.
- Updated seed refuses a legacy NCAA demo database instead of silently rewriting its history. Repeated seeding into a fresh disposable database must remain idempotent.
- Shared DataTable and entity links keep information dense and connected; sorting is supported for real displayed fields, not fictional composite analytics.
- No new app dependencies, authentication, scraping, live data, or final algorithms.

## Validation scope

Required checks: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`. The ten foundation/discovery tests verify fixture references, complete independent ranking orders, filters, window samples, stable entities, unavailable-stat sorting, two-way roles, and concurrent AFL/organization membership. Production route/browser checks cover navigation, controls, sorting, profile anchors, links, empty states, and narrow-screen scrolling. PostgreSQL checks cover fresh migrations, repeatable seeding, and additive migration preservation. These validate a fictional development preview, not a real-data pipeline or production analytics quality.

## Completed validation

| Check                   | Result                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`     | Passed, including generated route types                                                                               |
| `npm run lint`          | Passed without warnings                                                                                               |
| `npm test`              | 10 tests passed; none skipped                                                                                         |
| `npm run build`         | Production build passed without PostgreSQL; 51 pages generated                                                        |
| Chromium product review | Passed at 1440px desktop and 390px mobile; no browser exceptions or page overflow                                     |
| Linked routes           | All 48 discovered application routes returned 200; missing entity routes returned 404; `/market` redirected to `/`    |
| PostgreSQL              | Fresh migrations and two seed runs passed with unchanged row counts                                                   |
| AFL integrity           | Three fall-assigned players retain organization membership; one fall team includes two parent organizations           |
| Additive migration      | Legacy player/membership IDs, batting counts, and score observations preserved; existing team organization stays null |
| Legacy seed guard       | Expected refusal confirmed; legacy records remain unchanged                                                           |

Browser interactions included default controls, both discovery modes, all contexts and timeframes, hitter/pitcher/two-way filtering, numeric sorting, search/reset/empty states, screener conditions, expanded pitching columns, player anchors and trajectory metric switching, organization scope, AFL profiles, and chronological linked news. No live baseball data, real scoring methodology, or production deployment was validated or introduced.

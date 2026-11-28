# Product

Prospect Terminal is a player-first Minor League Baseball analytics and scouting site for fans, scouts and
analysts. The central object is the **player**; organizations, affiliates, leagues, levels and games are
context. Goal: the premier MiLB prospect-discovery and player-development tool.

## Principles (non-negotiable)

1. **Correct before clever.** Only statistics derivable from ingested data, with standard definitions and
   visible sample sizes. No invented data, constants, rankings or causal claims.
2. **Per-level context.** Statistics and Momentum are computed within one level; no cross-level blending or
   normalization without an approved method (docs/DECISIONS.md).
3. **Honest uncertainty.** Small samples are flagged or suppressed; confidence is shown; unavailable
   features say so instead of faking them.
4. **Information-dense, fast.** Baseball Savant / FanGraphs style: white, charcoal, thin gray borders,
   restrained teal, compact tables. Desktop-first, usable on phones. Pages answer in about a second cold.
5. **Licensed data only.** MLB Stats API use is development-only until licensing is resolved
   (docs/DATA-LICENSING.md). No scraping of FanGraphs, Savant, Baseball America, TrackMan etc.

## Users and jobs

| User | Jobs |
|---|---|
| Fan | Who is hot in my team's system? How is a prospect doing at their new level? |
| Scout / analyst | Find players by level, position, age and performance; compare players; track a list over time; read trends with sample sizes. |
| Organization (later) | Monitor many players across affiliates efficiently. Needs licensed data and accounts first. |

## What exists today (2026 season, snapshot of AAA, AA, High-A, Single-A, AFL)

- **Home** (`/?level=`): Trending Prospects (Momentum risers/fallers, 7/14/30 days), Latest Results, Level Moves (observed, not official transactions), coverage.
- **Players directory** (`/players`): server-side filters (role, level, window 7d/14d/30d/season, text search, team, org, position, minimum sample), sortable standard batting/pitching columns, pagination. Works without JavaScript.
- **Player profile** (`/players/[id]?level=`): bio, per-level stat lines (never summed across levels), Momentum with confidence and persistence, development timeline, window splits, within-level percentile fingerprint, game log, roster observations.
- **Trends** (`/trends`): risers/fallers per component, Performance × Momentum map.
- **Data** (`/data`): methodology, coverage, what is not available yet.
- **Analytics:** Momentum V1 (Balanced) only. See docs/ANALYTICS.md.

## Not available (and why)

| Feature | Status |
|---|---|
| Prospect Grade, P(MLB), Prospect Priority, Pure Performance, rankings | Methodology not approved (owner decision) |
| Breakout detection | Validated as approved on 2026 data and failed at every level (D-023): not shown |
| Historical comparables (similar players in past seasons) | Requires prior seasons; same-season similar players are on profiles (D-028) |
| Multi-season history, prior-season baselines, career lines | Requires ingesting prior seasons (ingestion approval) |
| Transactions, injuries, promotion dates, news, video | No licensed source |
| Handedness / home-away splits, batted-ball, Statcast-style tracking | Not in the ingested data |
| Accounts, shared watchlists | Not built; needs auth + privacy work |
| Bulk export (CSV) | Blocked on data licensing (bulk redistribution) |

The roadmap (docs/ROADMAP.md) and the task list (docs/TASKS.md) carry this forward.

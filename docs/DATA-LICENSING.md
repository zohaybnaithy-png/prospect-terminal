# Data licensing: open questions before a public launch

**Status: unresolved. This is a launch blocker.** All live data on Prospect Terminal comes from the
MLB Stats API (`statsapi.mlb.com`). The repository has treated this as development use from the
start (CLAUDE.md *Data licensing*, README, the site's footer and Data page). Nothing here is legal
advice. It lists what must be answered, by whom, before the site is public, especially if it is
commercial.

**A publicly reachable API is not a licence.** Being able to request the data says nothing about
the right to store it in bulk, republish it, derive products from it, or make money from them. The
ingestion code already says this for the AFL probe: "Connectivity is not permission to ingest or
redistribute." Treat every item below as **not permitted until confirmed in writing**.

## What the repository does with the data

- **Collects:** schedules, rosters, people (name, position, birth date, height, weight, bats/throws)
  and per-game box-score lines for Triple-A, Double-A, High-A, Single-A and the Arizona Fall League.
  Twice a day once the refresh timer is enabled.
- **Stores** every season in its own PostgreSQL database, indefinitely, with provenance (source IDs,
  capture hashes).
- **Republishes** it on public pages: statistics, game logs, rosters and biographical facts per
  player, a sitemap listing every player, and search.
- **Derives:** Momentum, splits, percentiles, risers/fallers, the Performance × Momentum map, level
  moves, coverage and freshness reports.

## Features that depend on MLB Stats API data

| Feature | Uses Stats API data | Notes |
|---|---|---|
| Player directory, search, filters | Yes: names, teams, organizations, positions, stats | the core of the site |
| Player profiles | Yes: biographical facts, season lines, game logs, roster observations, level history | |
| Momentum V1, What changed?, development timeline, fingerprint | Yes: derived from box-score lines | a derivative work of the data |
| Trends: risers/fallers, Performance × Momentum map | Yes: derived | |
| Homepage: trending, latest results, level moves, coverage, score strip | Yes | |
| Data & methodology page: coverage, last ingestion | Yes: counts and dates | |
| sitemap.xml (player list) | Yes: player IDs, names | makes the republished data discoverable |
| Planned: Prospect Grade, Pure Performance, P(MLB), Similarity, Breakout detection | Yes: would be derived from the same data | not implemented; formulas not final |
| Planned: prospect rankings, news, video highlights | No, needs **other** licensed sources | already shown as "needs a licensed source"; nothing is scraped |

Without permission to use the Stats API data publicly, there is no public product. Every
data-bearing page depends on it.

## Questions to resolve

**Rights and scope**

1. Which terms govern the MLB Stats API and its responses? Who is the counterparty (MLB Advanced
   Media / MLB / MiLB)? Retrieve and keep a dated copy of the terms. Live responses are commonly
   reported to carry a copyright notice pointing to MLBAM's terms, but that was **not verified
   here**: the build environment cannot reach the API. Check it yourself in a response body.
2. Are **non-commercial public** display and **commercial** display (ads, subscriptions, paid API)
   treated differently? What is the plan for each, and when?
3. Is **storing full seasons** in our own database permitted, or only transient display ("non-bulk")?
   For how long, and what must be deleted if permission ends?
4. Are **derived metrics** (Momentum, percentiles, future models) permitted? Do they inherit
   restrictions or attribution duties from the source data?
5. Does Minor League and **Arizona Fall League** data have the same terms as MLB data? Who licenses
   MiLB statistics commercially, and at what cost (licensed providers are the alternative)?

**Presentation**

6. What **attribution** is required, where (every page? the footer? the Data page?), and in what
   wording?
7. May team names, league names ("Triple-A", "Arizona Fall League"), and club and league marks be
   used? The site uses names and abbreviations only, no logos.
8. Is publishing a **sitemap** and allowing search indexing of player pages acceptable, or is that
   treated as redistribution?

**People's data**

9. Player **birth dates**, height, weight and handedness are personal data. What lawful basis and
   privacy notice apply (GDPR/UK GDPR for EU/UK visitors, CCPA/CPRA)? Some Single-A players may be
   minors. Is any field to be withheld?
10. How are correction and removal requests handled? Who is the contact?

**Operations**

11. What request rate and schedule are acceptable? (Twice daily with incremental captures; the
    backfill made full-season passes.) Is an API key or contact registration required?
12. If permission is refused or withdrawn: what is the shutdown or deletion procedure (Neon branches
    and backups, server caches, search-engine removal)?

## Decision needed from the owner

Either:

- (a) written permission covering items 1–8 for the intended use; or
- (b) a licensed data provider (a new `SourceAdapter`; the ingestion pipeline is
  provider-agnostic by design); or
- (c) a private, non-public deployment only.

Until one of these is in place, staging stays private (basic auth and `PT_INDEXING=off`;
docs/STAGING-SERVER.md), and no public launch happens.

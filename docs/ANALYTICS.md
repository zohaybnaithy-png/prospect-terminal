# Analytics V1 — Momentum framework (provisional)

Momentum measures **change relative to the player's own earlier AFL games**, on a −100…+100 scale. 0 = performing like their own baseline (not league average). The final weighting model is **not chosen**; three candidates are implemented for review.

## Layout

| Module | Role |
|---|---|
| `src/analytics/config.ts` | Every weight, threshold, window, sample-size and normalization parameter; candidate models; bands; percentile categories. |
| `metrics.ts` | Metric registry (value from an aggregated sample, direction, scale floor/fallback). New data (EV, xwOBA, whiff%, Stuff+ …) = register a metric + reference it in config. |
| `windows.ts` | Indexes completed-game lines (read-model rule: final + complete box score) and builds "recent vs. everything before" ranges with the shared `windowBounds`/`aggregate*`. |
| `population.ts` | AFL normalization scales (`level-sd` or `change-sd`) and qualified populations. |
| `momentum.ts` | Standardized component changes, weighted combination, reliability, ±100 mapping, bands. |
| `persistence.ts` | Trend Persistence. |
| `explain.ts` | Deterministic explanation templates (no LLM). |
| `engine.ts` | Composition: Momentum, timeline, fingerprint, Risers/Fallers, Performance × Momentum map, model comparison. |
| `views.ts` | Serializable view models + per-snapshot context cache for pages. |
| `report.ts`, `scripts/analytics-compare.ts` | Offline Markdown/JSON model comparison (`npm run analytics:compare`). |

Everything is pure and read-only; pages compute view models server-side and pass display rows to client components.

## Calculation

1. **Windows.** Recent = the read model's 7D/14D/30D bounds ending on the date (as-of = latest completed game). Baseline = all earlier season games.
2. **Metric change.** `z = direction · (now − before) / scale`, clamped to ±`zClamp`. Positive always means improvement (K% down for hitters, ERA down for pitchers). `scale` = AFL population SD (qualified players), floored at the metric's `minScale`; `fallbackScale` only when < `minPopulation` players qualify.
3. **Components.** Hitters: production (OPS), power (ISO), contact (K%), discipline (BB%). Pitchers: strikeouts (K% 0.7, K/9 0.3), command (BB% 0.7, BB/9 0.3), baserunners (WHIP), run prevention (ERA). Missing metrics/components are dropped and weights renormalize — nothing is imputed.
4. **Combine.** Combined z = Σ model weight · component z. Raw score = `100·tanh(z / zDivisor)`.
5. **Reliability.** `n_eff = recent·baseline / (recent + baseline)` (PA for hitters, BF for pitchers), `reliability = n_eff / (n_eff + k)`. Confidence Low/Medium/High from `reliability.levels`. Below hard floors (`minRecent`, `minBaseline`) no score is produced.
6. **Persistence.** See below; yields a multiplier in [`multiplierFloor`, 1].
7. **Final** = raw · reliability · persistence multiplier. Component "points" split the final value proportionally to weight·z.

### Trend Persistence

Checkpoints: the same window ending today, 7, 14 and 21 days earlier (`stepDays`, `checkpoints`), each compared with everything before it, using the combined z of **all** components (not batting average).

- A checkpoint *agrees* if |z| ≥ `activeZ`, same sign as today, reliability ≥ `minReliability`.
- `runLength` = consecutive agreeing checkpoints back from today; `trendLengthDays = (run − 1)·step + window` (capped at AFL days played).
- `crossWindowAgreement` = share of the other windows (7D/14D/30D) pointing the same way.
- `score = runWeight·min(1, (run−1)/(targetRun−1)) + crossWeight·crossAgreement`; level Low/Medium/High.
- State: `neutral` (|z| small), `emerging` (only today — "Recent only"), `strengthening` / `sustained` / `fading` (persisted; |z| up / similar / down by `changeDelta`), `reversed` (previous checkpoint trended the other way), `insufficient`.
- Multiplier = `floor + (1 − floor)·score`: a one-window spike keeps 60%, a sustained multi-window trend keeps 100%.

## Candidate models (weights)

| | Production | Power | Contact | Discipline | | Strikeouts | Command | Baserunners | Run prev. |
|---|---|---|---|---|---|---|---|---|---|
| Production-heavy | .55 | .20 | .125 | .125 | | .20 | .15 | .30 | .35 |
| Skills-heavy | .15 | .25 | .35 | .25 | | .45 | .35 | .15 | .05 |
| Balanced (provisional display) | .25 | .25 | .25 | .25 | | .30 | .25 | .25 | .20 |

## Known limitations

- The AFL season is ~4 weeks: the **30D window covers the whole season, so it has no baseline** and shows no change. 14D persistence can only reach ~2 checkpoints.
- Baselines are AFL-only (no prior-season data is ingested); early-season baselines are small, so confidence is rarely "High" under current thresholds.
- `tanh` saturates for combined z > ~2, compressing differences between very large changes.
- The map's x-axis is a single season statistic's AFL percentile, deliberately not a composite "Pure Performance" model.
- No dated development events exist in the database; the timeline overlay API (`TimelineEvent`) is empty by design.

## Pages

`/trends` (Risers/Fallers, Performance × Momentum), AFL player profiles (header Momentum + "Why?", What changed?, fingerprint, timeline), `/analytics/models` (development only; `ANALYTICS_DEBUG=1` in production).

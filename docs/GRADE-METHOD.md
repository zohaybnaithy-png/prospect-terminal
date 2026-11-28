# Prospect Grade — methodology proposal (T-403, P-004)

**Status: proposal, not approved, not implemented.** Nothing is built until the owner approves §9. Parameters marked
*(owner)* are decisions; *(calibrate)* are set by the validation in §6 before anything is shown. As with breakout
detection and similarity, the owner chooses among options **before** the real-data run, never after.

## 0. The short version

A Prospect Grade is a claim about the **future**: how likely a player is to become a major leaguer, and how good. A
claim like that can be checked only against players whose futures are already known. Today the site holds **one
season** (2026) and no outcomes. So no Grade can be validated now, and this proposal does not offer one that cannot be
validated.

The proposal is:
1. **Define the Grade now** (§1–§5), so that its inputs, target and scale are fixed before any data is seen.
2. **Get the historical data it needs** (§2): past MiLB seasons and the MLB careers that followed. That is T-501
   (ingestion and Neon capacity approval) and T-601 (licensing) territory, so it is the owner's decision.
3. **Validate the Grade on past cohorts, forward in time** (§6), against simple baselines, with criteria fixed in
   advance (§7).
4. Show it only if it passes, and with its uncertainty (§8).

Until step 3 passes, the site keeps showing "Prospect Grade: not available".

## 1. What the Grade means

For a player at one MiLB level in one season, the Grade estimates the player's **expected MLB value over the six
seasons after that season**, from statistical performance and context only. It is reported on the familiar 20–80
scouting scale *(owner)*, defined by outcome tiers (§3), so a 50 means "the outcome expected of an average regular"
in the historical data, not a scout's opinion.

It is **not** a scouting grade, it does not use tools or video, and it does not know about injuries, makeup or
organizational plans. It is labelled "statistical Prospect Grade" everywhere.

P(MLB) (probability of reaching the majors) is computed by the same model (§4) and can be shown on its own *(owner)*.

## 2. Data

- **Training and validation:** MiLB seasons 2012–2019 and 2021 (2020 had no MiLB season), with the same per-level
  statistics the site already ingests, and MLB playing time and results through 2026 from the same provider (MLB
  Stats API). Cohorts after 2020 have incomplete outcomes; §6 handles this.
- **Context available from the provider:** birth date (age vs level, D-020), primary position, bats/throws, level,
  organization. Draft round and pick (from the provider's draft data) *(owner: include or not; it improves accuracy
  but partly encodes scouting opinion)*.
- **Not used:** any proprietary source (FanGraphs, Baseball America, Savant, TrackMan); public prospect rankings;
  anything scraped. CLAUDE.md data-licensing rules apply; public display depends on T-601.
- **Per level, never blended** (D-002): a player at two levels in a season gets an input row per level; the Grade
  shown on a level's profile uses that level's row (and the player's earlier rows, §3).

Requires approval: ingesting about nine past seasons is a live ingestion (T-501) and roughly 9× today's MiLB volume
in Neon. Estimate before approval: rows and storage per season from the 2026 load.

## 3. Target and scale

Outcome for a player-season row: MLB value in the six following seasons, in a provider-independent unit computed
from MLB statistics the site can ingest *(owner, proposed)*:
- **Hitters:** MLB plate appearances weighted by run value above replacement, approximated as
  `PA × (wOBA-like rate − replacement rate)` from box-score counts with fixed linear weights (documented, no
  park or defensive adjustments). Position group adjustments (C, SS/CF premium) as fixed published-style constants
  *(owner)*.
- **Pitchers:** batters faced weighted by (replacement FIP-like rate − FIP-like rate) from K, BB, HBP, HR.

Tiers (by percentile of outcome among players who reached MLB, fixed from the training cohorts): no MLB → 20–35;
up-and-down → 40; bench / reliever → 45; average regular → 50; above average → 55–60; star → 70+. The model predicts the
expected outcome; the Grade maps it onto the tiers. *(owner: 20–80 vs a 0–100 probability-style score)*

## 4. Model

- **Inputs per row:** level; age vs level; the similarity profiles' shrunk rates (K%, BB%, ISO, BABIP, SB rate for
  hitters; K%, BB%, HR/BF, BABIP, BF/app for pitchers) with their samples; position group; bats/throws; the same
  inputs for the player's previous level-season rows (trajectory), when they exist; draft round *(if approved)*.
- **Model:** two stages, both regularized and simple enough to explain: (a) P(MLB) by logistic regression; (b)
  expected value given MLB by a gamma/log-linear regression. Grade = expected value = P(MLB) × E[value | MLB].
  Gradient-boosted trees are the alternative *(owner)*; regression is proposed because each input's effect can be
  shown and checked ("one year younger at Double-A is worth …").
- **Per role**, not per level: level is an input, so the model learns how Double-A production translates relative to
  High-A from history instead of assuming it. This is the only place levels are related, and only through outcomes.
- **Uncertainty:** an 80% interval per player from the model (bootstrap over players), shown next to the Grade.

## 5. Output

Profile: "Statistical Prospect Grade" with the 80% interval, P(MLB), the top three inputs pushing it up and down, and
the sample it rests on. Below 100 PA / 100 BF at the level *(calibrate)*: "not enough data". AFL: not offered (the
model is trained on full MiLB seasons). No overall ranking page until the owner approves one separately.

## 6. Validation plan (before anything is shown)

Offline, seeded, one script, one Markdown report, the synthetic check first (as for breakout and similarity).

1. **Forward in time.** Train on cohorts 2012–2015, predict 2016–2017; train on 2012–2017, predict 2018–2019. The
   test cohorts are always later than the training cohorts, so the model is judged on players it was not fitted on, in
   seasons after the ones it learned from (league-wide changes count against it). Grouped by player: a player's rows
   are all in training or all in test within a split. Outcomes of every cohort are known today (six-season windows end
   by 2025), except 2021 (§6.4).
2. **Baselines:** (a) level only; (b) level + age vs level; (c) level + age + OPS (hitters) / K−BB% (pitchers). The
   Grade must beat (c), not only (a).
3. **Measures:** P(MLB): Brier score, AUC, calibration by decile. Value: rank correlation (Spearman) and mean absolute
   error in tier units; calibration of the 80% intervals (≈ 80% of outcomes inside).
4. **Incomplete outcomes:** 2021+ cohorts are used only for P(MLB) with a shorter window, reported separately.
5. **Fairness checks:** errors by level, position group, age group and handedness; no group systematically
   over- or under-graded beyond the interval.

## 7. Proposed success criteria (owner decides)

Per role:
1. P(MLB) beats baseline (c) on Brier score in both forward splits (90% bootstrap interval of the improvement > 0) and
   is calibrated (every decile within ±5 points of observed).
2. Expected value beats baseline (c) on Spearman correlation in both splits.
3. 80% intervals contain 75–85% of outcomes.
4. No subgroup in §6.5 is off by more than one tier on average.

Fails 1: no Grade and no P(MLB). Passes 1, fails 2: P(MLB) only, no Grade. A role that passes shows the Grade on
MiLB profiles with the §5 output.

## 8. What changes on the site (after approval, data and validation)

Profile: a compact Grade block (Grade, interval, P(MLB), drivers, sample) in place of "Prospect Grade: not available".
`/data`: method and validation summary. Directory: an optional Grade column. Nothing else, and no public launch before
T-601 (licensing).

## 9. Decisions requested from the owner

1. Approve the definition (§1), the scale (20–80) and the target (§3), including the position adjustments.
2. Approve the data plan (§2): historical seasons 2012–2019 and 2021 plus MLB outcomes — this is a request to start
   T-501 (live ingestion, Neon capacity; a sizing estimate comes first) — and whether draft round is an input.
3. Approve the model (§4: two-stage regularized regression) and the validation and criteria (§6–§7), including the
   outcomes "P(MLB) only" and "no Grade".
4. Confirm the order: nothing is ingested before the sizing estimate is approved, nothing is shown before the
   validation passes, and nothing is public before T-601.

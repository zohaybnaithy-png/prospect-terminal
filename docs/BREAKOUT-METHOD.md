# Breakout detection — methodology proposal (T-402, P-004)

**Status: proposal, not approved, not implemented.** Nothing here ships, and no code is written (the validation
script included), until the owner approves the method and the success criteria in §7. Every parameter marked
*(owner)* is a decision; every parameter marked *(calibrate)* is set by the validation in §6, from our own data,
before anything is shown to users.

## 1. What a "breakout" means here

A **breakout** is a player whose *underlying skill rates* at one level have improved over a sustained, sizeable
recent stretch, by more than chance would plausibly produce, to a level that is **good for that level**.

How it differs from what already ships:

| | Momentum V1 (shipped) | Breakout (proposed) |
|---|---|---|
| Question | Is the player trending vs their own earlier games? | Has his skill profile plausibly *stepped up* to a good level? |
| Output | Continuous −100…+100 for everyone with a sample | A rare yes/no flag (plus "watch"), most players have none |
| Windows | 7D / 14D / 30D calendar windows | Sample-based blocks (last N PA / BF) |
| Inputs | Results and skills (OPS, ERA, WHIP, K%, BB% …) | Skill rates only (K%, BB%, ISO; K%, BB%) |
| Noise control | Reliability shrink + persistence multiplier | Shrinkage, a significance test with false-discovery control, persistence, and a level-standing bar |

Breakout is **not** a prediction of MLB success, not a ranking, and not a grade. It says "this change is large,
sustained and unlikely to be noise", nothing more.

## 2. Data used (and not used)

Only what is in the snapshot today (per-game completed-game lines, the read-model rule):

- Hitters: PA, AB, H, 2B, 3B, HR, BB, SO, HBP, SF per game.
- Pitchers: BF, SO, BB, HBP (when present), outs, H, HR, ER per game.
- Level as-of date, birth dates (for display only, §5).

Not available, so not used: prior seasons (T-501), pitch-level or batted-ball data (whiff%, chase%, exit
velocity), injuries, transactions, promotion dates, scouting reports. A breakout relative to *last season* is
therefore impossible in V1; the comparison is within this season at one level.

**Per-level only** (PRODUCT.md principle 2): every number is computed inside one level. Games at another level
are never pooled into either block. Promotions: §4.6.

**AFL: not available.** An AFL season is 4–6 weeks, so even everyday AFL players reach only about 100 PA, and most reach far fewer BF, below the two-block minimum (§4.1).
The AFL shows "not enough season for breakout detection" rather than a weaker version.

## 3. Signals

Skill rates were chosen because they stabilize faster than results and depend least on defense, park and
sequencing luck. Results (AVG, OPS, ERA, WHIP) are shown alongside but are **not** detection inputs, because
BABIP and strand-rate noise would dominate the flags.

| Role | Metric | Definition | Direction |
|---|---|---|---|
| Hitter | K% | SO / PA | lower is better |
| Hitter | BB% | BB / PA | higher is better |
| Hitter | ISO | (2B + 2·3B + 3·HR) / AB | higher is better |
| Pitcher | K% | SO / BF | higher is better |
| Pitcher | BB% | BB / BF | lower is better |

Composite *(owner)*: **equal weights** within a role (hitters ⅓ each; pitchers ½ each, i.e. K−BB% on a
standardized scale). This choice is deliberate: with no outcome data to fit weights against (no prior seasons, no
MLB outcomes), equal weights are the least arbitrary choice, and the Momentum Balanced decision (D-010) set the
same precedent.

## 4. Calculation

All steps are deterministic and pure, like Momentum.

### 4.1 Blocks

At as-of date *D*, for one player at one level:

- **Recent block R** = the player's most recent games at that level whose PA (BF) sum to at least
  `N_recent` *(calibrate; starting value 100)*, taking whole games.
- **Earlier block E** = all earlier games at that level this season; it must have at least `N_earlier`
  *(calibrate; starting value 100)*.
- Neither minimum met → no breakout state ("not enough data"), never an estimate.

Sample-based blocks (not calendar windows) mean an everyday player and a platoon player are compared on equal
evidence. Whole games keep the blocks reproducible from the game log.

### 4.2 Shrinkage toward the level

Each block's rate is shrunk toward the level's mean for that metric and role:

`shrunk = (count + k · μ_level) / (n + k)`

`μ_level` = the level's pooled rate (all qualified players at *D*). `k` = the sample at which the metric's
split-half reliability at that level reaches 0.5 *(calibrate per level and metric, §6.1)*. MLB research puts
K% around 60 PA and BB% around 120 PA; minor-league values will differ, so ours are estimated, not copied.

### 4.3 Change and its uncertainty

For each metric: `Δ = direction · (shrunk_R − shrunk_E)`.

Standard error: for K% and BB% the two-proportion binomial standard error of the raw rates; for ISO (not a
proportion) a game-level bootstrap within each block (`B = 2000` resamples, fixed seed). `z_metric = Δ / SE`.

Composite change: `z = Σ wᵢ z_metric,i / sqrt(Σ wᵢ² )` (the z of an equally weighted sum under independence;
the validation checks the correlation between metric z values and switches to a covariance-aware denominator if
it is material).

### 4.4 The four criteria

A player is flagged **Breakout** at *D* only if all hold:

1. **Significance.** The composite change survives false-discovery control across all players at that level and
   role on that date: Benjamini–Hochberg at `q` *(owner; proposed 0.10)*, with p-values taken from the
   permutation null of §6.2 rather than from the normal approximation.
2. **Size.** Composite effect ≥ `minEffect` *(calibrate; starting value 0.5 level SDs)*. With many players a
   significant but trivial change is possible; this stops it.
3. **Level standing.** Recent-block shrunk composite ≥ the `P` percentile *(owner; proposed 70th)* of
   qualified players at that level. Going from poor to average is improvement, not a breakout.
4. **Persistence.** Criteria 1–3 also held at ≥ 2 of the 3 previous weekly checkpoints (*D*−7, −14, −21), each
   computed with only the data available on that date. This reuses the Momentum persistence idea
   (ANALYTICS.md) without its weights.

**Watch** (shown, but less prominently): criteria 2–3 hold and the composite is significant before false-discovery
control, but 1 or 4 is not yet met. It means "worth looking at, not yet established".

V1 is **upward only** *(owner)*. A symmetric "breakdown" flag is possible with the same machinery, but it is
more likely to reflect an injury we cannot see, so it is proposed as a later decision.

### 4.5 Onset date and explanation

Onset = the first checkpoint of the current persistent run. The explanation is template-based (no LLM), and
always shows samples, e.g.:

> Breakout at Double-A since Jul 14: K% 27.8% → 19.1% and ISO .121 → .214 over the last 118 PA, against
> 241 PA before. Level standing: 84th percentile. Walk rate unchanged.

### 4.6 Promotions

A promoted player starts over at the new level: earlier-level games are not used in either block there. A flag
earned before a promotion stays visible on the old level's page with its end date ("flagged at High-A, Jun 2 –
Jul 20, then promoted"). Carrying a breakout across levels means comparing rates across levels, which needs its
own approved method (PRODUCT.md principle 2), so it is out of scope.

## 5. What is deliberately left out

- **Age.** Age vs level (D-020) is shown next to the flag, but does not affect it. Weighting age would make it a
  prospect valuation, which is Prospect Grade's job (T-403).
- **Results stats, BABIP, ERA.** Too noisy at these samples (§3).
- **Position, org, draft or bonus status.** Not in the data, and not skill.
- **Rankings.** Flags are not ordered by "breakout score"; lists sort by onset date or level standing, with the
  criteria visible.

## 6. Validation plan (before anything is shown)

Everything runs offline on the existing 2026 snapshot (four MiLB levels, full regular season), with no new data
and no live ingestion. One script, `npm run analytics:breakout-validate` (to be written only after approval),
produces a Markdown report in the PR for the owner to review. Fixed seeds; the report is reproducible.

### 6.1 Reliability (sets `k`)

For each level × role × metric: split each player's games into odd and even halves, correlate the half-rates
across players with at least 2·n PA, and apply Spearman–Brown. Fit `k` so that reliability(n) = n / (n + k).
Report `k` with a bootstrap interval. If a metric's interval is too wide (reliability at 100 PA below 0.3), it
is dropped from that level.

### 6.2 Null calibration (sets the false-positive rate)

Under "no real change", the order of a player's games carries no information. For each level, shuffle each
player's game order 1,000 times and rerun the whole detector, all four criteria included. This gives:

- the empirical null distribution of the composite z (the p-values used in criterion 1);
- the expected number of flags per level per date when nothing is happening;
- whether `q`, `minEffect` and the persistence rule together keep that number near zero.

Target *(owner)*: under the null, at most 1 Breakout flag per level per date on average.

### 6.3 Holdout retention (does a flag mean something?)

This is the main test. Pick cutoffs at 15 Jun, 15 Jul and 15 Aug 2026. Detect using only games up to each
cutoff. Then measure the same shrunk composite on each player's games *after* the cutoff, at the same level, for
players with at least 75 PA/BF afterwards.

- **Retention** = (post-cutoff composite − earlier-block composite) / (recent-block composite − earlier-block
  composite), averaged over flagged players. 0 = fully regressed, 1 = the change was fully real.
- **Matched controls.** For each flagged player, unflagged players at the same level with a similar earlier-block
  composite (±0.25 SD) and PA. This separates real change from ordinary regression to the mean.
- **Baselines the detector must beat:** (a) the top Momentum 30D players, (b) the top recent-block OPS
  players, with the same number of players flagged. If Breakout retains no more than these, it adds nothing and
  should not ship.
- **Promoted players.** Players promoted after a flag leave the level and drop out of the post-cutoff sample,
  which biases retention. Promotion within 45 days is reported separately as an outcome (it is the
  organization's own judgment), and is never used as an input.

### 6.4 Stability

Day-to-day churn: the share of flags that switch on and off within 14 days. A flag that flickers is worse than
no flag.

### 6.5 Review

The baseball-analyst agent reviews the full list of flags at one cutoff per level, not a hand-picked sample, for
obvious errors (position players pitching, rehab assignments, data artifacts). Problems found become explicit
exclusions with a rule, never one-off removals.

## 7. Proposed success criteria (owner decides)

Ship only if all hold, for each level reported separately:

1. Null calibration: ≤ 1 expected false flag per level per date (§6.2).
2. Mean retention of flagged players ≥ 0.5, and above the matched controls by a margin whose 90% bootstrap
   interval excludes 0 (§6.3).
3. Retention above both naive baselines (§6.3).
4. Churn: ≤ 20% of flags reverse within 14 days (§6.4).
5. At least 10 flagged players per level and cutoff, so the retention estimate is not anecdotal. A level that
   fails this does not get the feature, rather than getting a loosened one.

A level that fails shows "Breakout detection is not available at this level" with the reason. Thresholds are
never loosened after seeing results to make a level pass; a changed rule means a new, documented validation run.

## 8. Where it would appear (after approval and validation)

Profile: a small labelled badge with the explanation, samples and onset date, next to Momentum. Players directory:
an optional "Breakouts" filter (not a sort). Trends: a Breakouts list per level, ordered by onset. `/data`: this
method in plain language, the validation summary, and the limits in §2.

## 9. Decisions requested from the owner

1. Approve the definition (§1) and the signal set (§3), including equal weights.
2. Approve the criteria (§4.4) and the proposed values: `q` = 0.10, level standing at the 70th percentile,
   persistence 2 of 3 checkpoints, and upward only.
3. Approve age as display-only (§5).
4. Approve the validation plan (§6) and the success criteria (§7). After approval, the first deliverable is the
   validation script and its report only, still with no user-facing feature.

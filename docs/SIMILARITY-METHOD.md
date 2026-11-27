# Player similarity — methodology proposal (T-404, P-004)

**Status: approved as proposed 2026-11-27 (D-024); validated 2026-11-27 (D-025, §11): pitchers usable as a browsing aid, hitters
need a position rule first. Nothing is shown on the site.** Parameters marked *(owner)* are decisions (the proposed defaults were approved). Parameters marked
*(calibrate)* are set by the validation in §6 before anything is shown. As with breakout detection, the owner chooses
among options **before** the real-data run, never after.

## 1. What "similar" means here

For a player at one level, the **most similar players** are the players at the **same level, same role and same
season** whose skill profile (§3) and age relative to the level are closest, measured on a scale that accounts for
sample size.

It is a descriptive comparison, "players who have looked like this at this level this year". It is **not** a
projection, not a "comp" in the scouting sense (a career path), not a grade, and says nothing about MLB outcomes.
Historical comps ("players who looked like this at Double-A and then…") need prior seasons (T-501) and would be a
separate proposal.

Use cases: from a profile, "players like this one" to browse; on `/compare`, a starting point for a side-by-side.

## 2. Data

Only the snapshot, per level (PRODUCT.md principle 2): season-to-date completed-game counts and birth dates. No
cross-level comparison: a player who played at two levels has one similarity list per level, each from that level's
games only. AFL: not offered (samples too small, as for breakouts).

## 3. Profile

| Role | Dimensions |
|---|---|
| Hitter | K%, BB%, ISO, BABIP, SB rate (SB per single + BB + HBP, a proxy for times on first; CS is not always present), age vs level |
| Pitcher | K%, BB%, HR per BF, BABIP allowed (approximate: (H − HR) / (BF − K − BB − HBP − HR); no sac-fly data), BF per appearance (starter vs reliever usage; starts are not in the data), age vs level |

Every rate is **shrunk toward the level mean** with the per-level reliability constants `k` measured in the breakout
validation (docs/reports/breakout-validation-2026.md §6.1, for K%, BB% and ISO). For the new rates (BABIP, SB rate,
HR/BF), `k` is estimated the same way, by odd/even split-half reliability. A dimension whose reliability at the
player's sample is below 0.3 is down-weighted by that reliability (§4.2), so noisy dimensions such as BABIP count
for little at small samples.

Age vs level (D-020) is included by default *(owner)*, because a 19-year-old and a 25-year-old with the same line are
not similar players at a level. It can be made optional.

## 4. Distance

1. **Standardize.** Each shrunk rate is converted to a z-score among qualified players at the level and role
   (`n ≥ minSample` *(calibrate; starting value 100 PA / 100 BF)*).
2. **Reliability weights.** The weight of dimension `j` for a pair of players is `w_j = √(rel_j(n_a) · rel_j(n_b))`,
   where `rel(n) = n / (n + k)`. Two small-sample players are compared mostly on the stable dimensions.
3. **Distance.** Weighted Euclidean on the z-scores, `D = √(Σ w_j (z_aj − z_bj)² / Σ w_j)`. Mahalanobis (accounting
   for correlated dimensions such as K% and ISO) is the alternative *(owner)*. Euclidean is proposed because it is
   explainable per dimension ("closest on K%, furthest on age").
4. **Similarity score.** `S = 100 · exp(−D² / 2)` (100 = identical, 61 = one SD apart on average, 14 = two SDs).
   It is shown only alongside the per-dimension differences.

Equal base weights across dimensions *(owner)*, for the same reason as Momentum Balanced (D-010) and breakouts: no
outcome data to fit weights against.

## 5. Output

Top `N` *(owner; proposed 5)* most similar players at the same level and role, each with the score, sample sizes,
and the 2–3 dimensions that are closest and furthest. A player below `minSample` gets "not enough data for
similar players" rather than a list. Ties are broken by sample size, then by id (deterministic).

## 6. Validation plan (before anything is shown)

Offline, on the existing 2026 snapshot. One script, built only after approval, writes a Markdown report. Seeded.
A synthetic-data check runs first, to show the tests can pass and fail as intended, before the real-data run (the
breakout lesson, BREAKOUT-METHOD.md §10).

1. **Stability (split-half).** Compute every player's top-5 list from odd games only and again from even games only.
   *Overlap* = the share of the odd-game list found in the even-game top 10. Compare it with chance (5 / qualified
   players × 10) and with a simpler baseline, a single-stat nearest neighbor (closest OPS or closest K−BB%).
2. **Predictive meaning (holdout).** At cutoffs 15 Jun, 15 Jul and 15 Aug, compute similar players from games up to
   the cutoff. Predict each player's post-cutoff skill rates (≥ 75 PA/BF after) as the mean of their 5 most similar
   players' post-cutoff rates. Compare the error with (a) the player's own shrunk pre-cutoff rate and (b) the level
   mean. Similar players should carry *some* information beyond the player's own line. If they do not, the list is a
   reshuffled stat table with no added value.
3. **Face validity.** The baseball-analyst agent reviews complete lists for 20 randomly chosen players per level
   (random, not hand-picked), checking for obvious mismatches such as starters matched with relievers, or extreme ages.
4. **Sensitivity.** How much lists change when `minSample`, the age dimension, or Euclidean vs Mahalanobis changes.
   This is reported for the owner's information, but the choice is made before the run.

## 7. Proposed success criteria (owner decides)

For each level × role:

1. Split-half overlap ≥ 3 × chance and above the single-stat baseline.
2. Holdout: the mean of the similar players' post-cutoff rates, combined with the player's own rate, lowers the
   prediction error versus the player's own rate alone (mean over cutoffs, 90% bootstrap interval of the improvement
   excludes 0). If not, similar players are shown only as a browsing aid labelled "similar so far this season", with
   no claim of predictive value. This is a smaller, honest feature, not a failure.
3. Face validity: no systematic mismatch class found (for example usage pattern or handedness, which is in the player data). Problems become explicit
   rules, never one-off removals.
4. At least 50 qualified players at the level and role, so the standardization is meaningful.

A level/role that fails criterion 1 or 4 shows "similar players are not available at this level".

## 8. Where it would appear (after approval and validation)

Profile: a compact "Similar at <level>" table (5 rows: player, score, sample, closest/furthest dimensions) linking
to `/compare`. `/data`: the method in plain language and the validation summary. No ranking or sort by similarity
anywhere else.

## 9. Decisions requested from the owner

1. Approve the definition (§1) and profiles (§3), including age vs level as a dimension.
2. Approve the distance (§4): shrunk z-scores, reliability weights, weighted Euclidean, equal base weights, top 5.
3. Approve the validation plan (§6) with the synthetic check first, and the success criteria (§7), including the
   "browsing aid only" outcome when criterion 2 fails.

## 10. Implementation notes (fixed before the real-data run)

Code: `src/analytics/similarity/` (config, profiles, validate), CLI `scripts/similarity-validate.ts` (reads
`.data-snapshot/` only; `--appendix` prints the face-validity lists), fictional data `scripts/similarity-synthetic.ts`,
tests `scripts/similarity.test.ts`. Run with `node --import tsx scripts/similarity-validate.ts`. Choices the proposal
left open, committed before the real-data run:

1. **Data.** Completed games only. Pitcher BABIP uses hit batters when the line has them (0 otherwise). BF per
   appearance is shrunk in appearances like the rates. `k` comes from odd/even split-half reliability (Spearman–Brown,
   `k = n̄(1 − rel)/rel`, players with ≥ 2 × minSample), the BREAKOUT-METHOD.md §6.1 estimator; a dimension with no
   measurable reliability gets `k = ∞` (shrunk to the mean, weight 0). Age is the D-020 value, unrounded.
2. **Stability.** Halves are alternating games in date order. A player must reach minSample in each half; the pool is
   players qualified in both halves, so chance is `10 / (pool − 1)`. `k` is the full-season value; level means and SDs
   are each half's own. The baseline (closest OPS / closest K−BB%) uses the same pool. Criterion 1 uses point estimates;
   90% bootstrap intervals are reported.
3. **Holdout.** At each cutoff, `k`, level means and SDs come from games through the cutoff only. The pool is players
   with ≥ minSample before and ≥ 75 after, and neighbors are drawn from the pool, so every neighbor has post-cutoff rates.
   Predicted dimensions: every rate except BF/app and age. Errors are divided by the SD of the observed pre-cutoff rates
   among qualified players (the SD of shrunk rates can be near zero when reliability is very low). Combined
   prediction = (1 − α) · own shrunk rate + α · neighbors' mean post-cutoff rate; α on a 0.05 grid, chosen on the other
   cutoffs only (leave-one-cutoff-out). A cutoff with fewer than 20 players is skipped. Improvement = mean over cutoffs of
   the per-cutoff mean of MSE(own) − MSE(combined); 90% interval by bootstrapping players within cutoffs, α fixed.
4. **Face validity.** 10 hitters and 10 pitchers per level, seeded random sample of qualified players at season end.
   Automatic checks over every list compared with all pairs: mean absolute age difference, starter-like (≥ 15 BF/app)
   paired with reliever-like (< 8), position group (C / IF / OF / other) and catcher mismatch, handedness. The
   baseball-analyst agent reviews the appendix; criterion 3 is recorded after that review.
5. **Sensitivity** (reported only): minSample 75 and 150, without age, Mahalanobis (inverse correlation matrix of the
   z-scores, reliability-scaled differences).

**Synthetic check** (fictional seasons, 240 hitters and 240 pitchers per level, 8 Apr – 19 Sep). With planted
archetypes, all 8 level × role combinations pass criteria 1, 2 and 4 (overlap 0.26–0.29 vs chance 0.04 and baseline
0.06; holdout improvement 0.03–0.09, every 90% interval above 0). With identical true talent (noise only), all 8 fail
criteria 1 and 2 (overlap 0.03–0.05 ≈ chance; improvement intervals include 0). The tests can pass and fail as intended.

## 11. Real-data result (2026 snapshot 8b418063511b, approved defaults, D-025)

Full report: docs/reports/similarity-validation-2026.md; random-sample lists: docs/reports/similarity-face-validity-2026.md.
Criteria as fixed in §7 and §10; nothing was tuned after the run.

| Level | Hitters C1 / C2 / C3 / C4 | Pitchers C1 / C2 / C3 / C4 |
|---|---|---|
| Triple-A | pass / fail / **fail** / pass | pass / fail / pass / pass |
| Double-A | pass / fail / **fail** / pass | pass / pass / pass / pass |
| High-A | pass / fail / **fail** / pass | pass / fail / pass / pass |
| Single-A | pass / pass / **fail** / pass | pass / fail / pass / pass |

- **C1 stability** passes everywhere: overlap 0.18–0.28 vs chance 0.03–0.04 (6.5–7.7×) and the single-stat baseline
  0.02–0.06. Age vs level is fixed across halves and carries much of this; without age (information only) overlap is
  0.09–0.17, still ≥ 3× chance and above the baseline at every level × role.
- **C2 holdout** passes for Double-A pitchers (+0.014 z², 90% [0.004, 0.025]) and Single-A hitters (+0.011
  [0.003, 0.018]); fails for the other six. Every gain is about 1% of the error of the player's own rate. 2 passes in 8 is
  more than chance alone would give (about 0.4), but the gains are too small to matter in practice.
- **C3 face validity** (baseball-analyst review of 80 random lists plus the automatic checks): **hitters fail at every
  level, position-blind** (position is not in the profile; neighbors share a position group at the random-pair rate,
  0.37–0.43 vs 0.36–0.38; catchers are routinely paired with first basemen and shortstops). Pitchers pass: no
  starter/reliever pairs (0 of every list), age gaps 0.5–0.8 years vs 1.7–3.4 random, skill rates close. Handedness is
  ignored (same-hand share equals random) and is disclosed rather than failed. Age and BF/app dominate the weights by
  design (removing age changes 55–62% of list entries).
- **C4** passes everywhere (508–617 qualified).

**Outcome.** Pitchers (all levels): available as a **browsing aid only, "similar so far this season", with no
predictive claim** (Double-A's C2 pass is too small to claim otherwise). Hitters: **not available** until an explicit
rule fixes the position mismatch, which per §7 needs owner approval and a re-run of this validation.

Proposed for the owner (not applied):
1. Hitters: neighbors only from the same position group (C / IF / OF / other); stricter option, catchers only with
   catchers. Re-run the validation with the rule before anything is shown.
2. Show position and Bats/Throws next to every neighbor.
3. Rank "closest / furthest" by weighted contribution w·Δz², not raw |Δz| (BABIP, weight 0.05–0.16, is named "furthest"
   for 59% of neighbors). Display only; scores unchanged.
4. Mark neighbors whose sample differs from the player's by 3× or more; show observed rates beside shrunk ones.

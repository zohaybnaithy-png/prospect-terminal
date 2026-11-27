# Player similarity — methodology proposal (T-404, P-004)

**Status: proposal, not approved, not implemented.** Nothing is built (the validation script included) until the
owner approves §9. Parameters marked *(owner)* are decisions. Parameters marked *(calibrate)* are set by the
validation in §6 before anything is shown. As with breakout detection (D-022), the owner chooses among options
**before** the real-data run, never after.

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

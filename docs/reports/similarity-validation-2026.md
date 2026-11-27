# Similarity validation report

Method: docs/SIMILARITY-METHOD.md (approved D-024). Source: build-time snapshot .data-snapshot/ (season 2026), snapshot id 8b418063511b4193b26f2b158aa94c3b9bc85e1df63115d164d1cd066c5cffb0.
Settings: minSample 100, top 5, age on, euclidean distance, seed 20261127, bootstrap 2000. These are the approved defaults.

## Verdict

Criterion 3 was decided by the baseball-analyst review recorded in docs/SIMILARITY-METHOD.md §11: hitters fail at every level (position-blind), pitchers pass. The table below shows the automatic criteria only.

| Level | Role | Qualified | C1 stability | C2 holdout | C3 face validity | C4 population | Verdict |
|---|---|---|---|---|---|---|---|
| Triple-A | hitter | 558 | **pass** | fail | review | **pass** | passes 1 and 4, fails 2: browsing aid only ("similar so far this season"), subject to criterion 3 |
| Triple-A | pitcher | 617 | **pass** | fail | review | **pass** | passes 1 and 4, fails 2: browsing aid only ("similar so far this season"), subject to criterion 3 |
| Double-A | hitter | 528 | **pass** | fail | review | **pass** | passes 1 and 4, fails 2: browsing aid only ("similar so far this season"), subject to criterion 3 |
| Double-A | pitcher | 580 | **pass** | **pass** | review | **pass** | passes 1, 2 and 4: similar players with predictive value, subject to criterion 3 |
| High-A | hitter | 524 | **pass** | fail | review | **pass** | passes 1 and 4, fails 2: browsing aid only ("similar so far this season"), subject to criterion 3 |
| High-A | pitcher | 572 | **pass** | fail | review | **pass** | passes 1 and 4, fails 2: browsing aid only ("similar so far this season"), subject to criterion 3 |
| Single-A | hitter | 508 | **pass** | **pass** | review | **pass** | passes 1, 2 and 4: similar players with predictive value, subject to criterion 3 |
| Single-A | pitcher | 561 | **pass** | fail | review | **pass** | passes 1 and 4, fails 2: browsing aid only ("similar so far this season"), subject to criterion 3 |

## 1. Reliability (split-half, full season)

k is in the dimension's own denominator units; reliability is at the qualification sample.

| Level | Role | Dimension | Players | Split-half r | k | Reliability at minSample |
|---|---|---|---|---|---|---|
| Triple-A | hitter | K% | 387 | 0.722 | 67 | 0.60 |
| Triple-A | hitter | BB% | 387 | 0.515 | 163 | 0.38 |
| Triple-A | hitter | ISO | 387 | 0.429 | 199 | 0.30 |
| Triple-A | hitter | BABIP | 387 | 0.165 | 548 | 0.10 |
| Triple-A | hitter | SB rate | 387 | 0.729 | 18 | 0.61 |
| Triple-A | pitcher | K% | 325 | 0.582 | 114 | 0.47 |
| Triple-A | pitcher | BB% | 325 | 0.519 | 147 | 0.40 |
| Triple-A | pitcher | HR/BF | 325 | 0.204 | 620 | 0.14 |
| Triple-A | pitcher | BABIP | 325 | 0.072 | 1305 | 0.05 |
| Triple-A | pitcher | BF/app | 325 | 0.974 | 0 | 0.96 |
| Double-A | hitter | K% | 340 | 0.712 | 70 | 0.59 |
| Double-A | hitter | BB% | 340 | 0.597 | 117 | 0.46 |
| Double-A | hitter | ISO | 340 | 0.505 | 148 | 0.37 |
| Double-A | hitter | BABIP | 340 | 0.111 | 836 | 0.07 |
| Double-A | hitter | SB rate | 340 | 0.746 | 16 | 0.63 |
| Double-A | pitcher | K% | 319 | 0.630 | 92 | 0.52 |
| Double-A | pitcher | BB% | 319 | 0.606 | 102 | 0.49 |
| Double-A | pitcher | HR/BF | 319 | 0.230 | 529 | 0.16 |
| Double-A | pitcher | BABIP | 319 | 0.088 | 989 | 0.06 |
| Double-A | pitcher | BF/app | 319 | 0.979 | 0 | 0.97 |
| High-A | hitter | K% | 326 | 0.719 | 66 | 0.60 |
| High-A | hitter | BB% | 326 | 0.654 | 89 | 0.53 |
| High-A | hitter | ISO | 326 | 0.503 | 141 | 0.38 |
| High-A | hitter | BABIP | 326 | 0.243 | 308 | 0.16 |
| High-A | hitter | SB rate | 326 | 0.737 | 16 | 0.63 |
| High-A | pitcher | K% | 308 | 0.536 | 128 | 0.44 |
| High-A | pitcher | BB% | 308 | 0.471 | 166 | 0.38 |
| High-A | pitcher | HR/BF | 308 | 0.246 | 454 | 0.18 |
| High-A | pitcher | BABIP | 308 | 0.106 | 753 | 0.07 |
| High-A | pitcher | BF/app | 308 | 0.965 | 0 | 0.95 |
| Single-A | hitter | K% | 317 | 0.800 | 41 | 0.71 |
| Single-A | hitter | BB% | 317 | 0.641 | 92 | 0.52 |
| Single-A | hitter | ISO | 317 | 0.458 | 165 | 0.34 |
| Single-A | hitter | BABIP | 317 | 0.220 | 345 | 0.15 |
| Single-A | hitter | SB rate | 317 | 0.760 | 15 | 0.66 |
| Single-A | pitcher | K% | 282 | 0.535 | 129 | 0.44 |
| Single-A | pitcher | BB% | 282 | 0.638 | 84 | 0.54 |
| Single-A | pitcher | HR/BF | 282 | 0.166 | 749 | 0.12 |
| Single-A | pitcher | BABIP | 282 | 0.073 | 1143 | 0.05 |
| Single-A | pitcher | BF/app | 282 | 0.952 | 1 | 0.93 |

## 2. Stability (§6.1)

Top 5 from odd games, looked up in the top 10 from even games, among players qualified in both halves. Chance = 10 / (players − 1). 90% bootstrap intervals.

| Level | Role | Players | Chance | Overlap | Baseline | Baseline overlap | Difference |
|---|---|---|---|---|---|---|---|
| Triple-A | hitter | 378 | 0.027 | 0.177 [0.161, 0.193] | closest OPS | 0.030 [0.024, 0.037] | 0.147 [0.129, 0.165] |
| Triple-A | pitcher | 303 | 0.033 | 0.253 [0.233, 0.275] | closest K−BB% | 0.024 [0.018, 0.031] | 0.229 [0.207, 0.250] |
| Double-A | hitter | 335 | 0.030 | 0.194 [0.177, 0.210] | closest OPS | 0.033 [0.026, 0.041] | 0.161 [0.144, 0.180] |
| Double-A | pitcher | 286 | 0.035 | 0.249 [0.231, 0.269] | closest K−BB% | 0.059 [0.045, 0.071] | 0.190 [0.169, 0.210] |
| High-A | hitter | 317 | 0.032 | 0.220 [0.199, 0.240] | closest OPS | 0.032 [0.025, 0.040] | 0.187 [0.167, 0.209] |
| High-A | pitcher | 276 | 0.036 | 0.250 [0.231, 0.271] | closest K−BB% | 0.046 [0.036, 0.057] | 0.204 [0.183, 0.225] |
| Single-A | hitter | 312 | 0.032 | 0.209 [0.191, 0.226] | closest OPS | 0.030 [0.023, 0.037] | 0.179 [0.160, 0.198] |
| Single-A | pitcher | 258 | 0.039 | 0.278 [0.258, 0.298] | closest K−BB% | 0.044 [0.035, 0.054] | 0.234 [0.212, 0.257] |

## 3. Predictive meaning (§6.2)

At each cutoff: similar players from games through the cutoff, among players with ≥ 100 before and ≥ 75 after. Errors are post-cutoff skill rates minus the prediction, in level SDs of the pre-cutoff observed rates, squared and averaged over the skill dimensions. Combined = (1 − α) · own shrunk rate + α · similar players' mean post-cutoff rate, with α chosen on the other cutoffs only.

| Level | Role | Cutoff | Players | α | MSE level mean | MSE own | MSE similar | MSE combined |
|---|---|---|---|---|---|---|---|---|
| Triple-A | hitter | 2026-06-15 | 246 | 0.15 | 1.053 | 0.736 | 0.862 | 0.730 |
| Triple-A | hitter | 2026-07-15 | 257 | 0.10 | 1.254 | 0.925 | 1.085 | 0.918 |
| Triple-A | hitter | 2026-08-15 | 170 | 0.20 | 1.474 | 1.146 | 1.402 | 1.152 |
| Triple-A | pitcher | 2026-06-15 | 236 | 0.15 | 0.967 | 0.803 | 0.972 | 0.805 |
| Triple-A | pitcher | 2026-07-15 | 227 | 0.15 | 1.127 | 1.004 | 1.215 | 1.005 |
| Triple-A | pitcher | 2026-08-15 | 100 | 0.05 | 1.446 | 1.295 | 1.466 | 1.287 |
| Double-A | hitter | 2026-06-15 | 235 | 0.10 | 0.990 | 0.708 | 0.892 | 0.709 |
| Double-A | hitter | 2026-07-15 | 206 | 0.10 | 1.234 | 0.935 | 1.163 | 0.934 |
| Double-A | hitter | 2026-08-15 | 140 | 0.05 | 1.838 | 1.434 | 1.747 | 1.431 |
| Double-A | pitcher | 2026-06-15 | 228 | 0.25 | 1.147 | 0.994 | 1.173 | 0.993 |
| Double-A | pitcher | 2026-07-15 | 230 | 0.20 | 1.290 | 1.135 | 1.320 | 1.127 |
| Double-A | pitcher | 2026-08-15 | 76 | 0.15 | 1.603 | 1.398 | 1.498 | 1.364 |
| High-A | hitter | 2026-06-15 | 219 | 0.15 | 1.140 | 0.798 | 0.974 | 0.793 |
| High-A | hitter | 2026-07-15 | 188 | 0.15 | 1.243 | 0.907 | 1.102 | 0.902 |
| High-A | hitter | 2026-08-15 | 44 | 0.15 | 1.933 | 1.513 | 1.829 | 1.508 |
| High-A | pitcher | 2026-06-15 | 223 | 0.05 | 1.009 | 0.864 | 1.075 | 0.864 |
| High-A | pitcher | 2026-07-15 | 191 | 0.00 | 1.127 | 0.996 | 1.211 | 0.996 |
| Single-A | hitter | 2026-06-15 | 231 | 0.20 | 1.161 | 0.874 | 1.010 | 0.862 |
| Single-A | hitter | 2026-07-15 | 180 | 0.20 | 1.320 | 0.996 | 1.185 | 0.987 |
| Single-A | pitcher | 2026-06-15 | 209 | 0.10 | 0.998 | 0.836 | 0.983 | 0.832 |
| Single-A | pitcher | 2026-07-15 | 174 | 0.15 | 0.998 | 0.876 | 1.052 | 0.873 |

| Level | Role | Improvement (MSE own − combined) | 90% interval |
|---|---|---|---|
| Triple-A | hitter | 0.0028 | [-0.0023, 0.0080] |
| Triple-A | pitcher | 0.0015 | [-0.0024, 0.0053] |
| Double-A | hitter | 0.0013 | [-0.0013, 0.0041] |
| Double-A | pitcher | 0.0144 | [0.0038, 0.0245] |
| High-A | hitter | 0.0052 | [-0.0046, 0.0144] |
| High-A | pitcher | -0.0002 | [-0.0014, 0.0010] |
| Single-A | hitter | 0.0106 | [0.0029, 0.0183] |
| Single-A | pitcher | 0.0038 | [-0.0013, 0.0092] |

## 4. Face validity (§6.3), automatic checks

Over every qualified player's list, compared with all pairs of qualified players. The random-sample lists are in the appendix for the review.

| Level | Role | Check | Neighbor pairs | All pairs |
|---|---|---|---|---|
| Triple-A | hitter | Mean absolute age difference (years) | 1.04 | 3.48 |
| Triple-A | hitter | Same position group C/IF/OF/other (share) | 0.41 | 0.36 |
| Triple-A | hitter | Catcher paired with non-catcher (share) | 0.23 | 0.28 |
| Triple-A | hitter | Same batting side (share) | 0.45 | 0.42 |
| Triple-A | pitcher | Mean absolute age difference (years) | 0.80 | 3.39 |
| Triple-A | pitcher | Starter-like paired with reliever-like (share) | 0.00 | 0.33 |
| Triple-A | pitcher | Same throwing hand (share) | 0.63 | 0.63 |
| Double-A | hitter | Mean absolute age difference (years) | 0.67 | 2.22 |
| Double-A | hitter | Same position group C/IF/OF/other (share) | 0.42 | 0.38 |
| Double-A | hitter | Catcher paired with non-catcher (share) | 0.24 | 0.27 |
| Double-A | hitter | Same batting side (share) | 0.44 | 0.43 |
| Double-A | pitcher | Mean absolute age difference (years) | 0.57 | 2.18 |
| Double-A | pitcher | Starter-like paired with reliever-like (share) | 0.00 | 0.35 |
| Double-A | pitcher | Same throwing hand (share) | 0.68 | 0.65 |
| High-A | hitter | Mean absolute age difference (years) | 0.56 | 1.79 |
| High-A | hitter | Same position group C/IF/OF/other (share) | 0.43 | 0.38 |
| High-A | hitter | Catcher paired with non-catcher (share) | 0.24 | 0.27 |
| High-A | hitter | Same batting side (share) | 0.43 | 0.43 |
| High-A | pitcher | Mean absolute age difference (years) | 0.47 | 1.79 |
| High-A | pitcher | Starter-like paired with reliever-like (share) | 0.00 | 0.31 |
| High-A | pitcher | Same throwing hand (share) | 0.69 | 0.66 |
| Single-A | hitter | Mean absolute age difference (years) | 0.54 | 1.80 |
| Single-A | hitter | Same position group C/IF/OF/other (share) | 0.37 | 0.37 |
| Single-A | hitter | Catcher paired with non-catcher (share) | 0.27 | 0.29 |
| Single-A | hitter | Same batting side (share) | 0.46 | 0.42 |
| Single-A | pitcher | Mean absolute age difference (years) | 0.45 | 1.73 |
| Single-A | pitcher | Starter-like paired with reliever-like (share) | 0.00 | 0.24 |
| Single-A | pitcher | Same throwing hand (share) | 0.73 | 0.70 |

## 5. Sensitivity (§6.4, information only)

Share of the default top 5 that a variant keeps, at season end.

| Level | Role | Variant | Players | Kept |
|---|---|---|---|---|
| Triple-A | hitter | minSample 75 | 558 | 0.88 |
| Triple-A | hitter | minSample 150 | 464 | 0.78 |
| Triple-A | hitter | without age vs level | 558 | 0.45 |
| Triple-A | hitter | Mahalanobis distance | 558 | 0.88 |
| Triple-A | pitcher | minSample 75 | 617 | 0.81 |
| Triple-A | pitcher | minSample 150 | 472 | 0.72 |
| Triple-A | pitcher | without age vs level | 617 | 0.39 |
| Triple-A | pitcher | Mahalanobis distance | 617 | 0.78 |
| Double-A | hitter | minSample 75 | 528 | 0.89 |
| Double-A | hitter | minSample 150 | 425 | 0.74 |
| Double-A | hitter | without age vs level | 528 | 0.43 |
| Double-A | hitter | Mahalanobis distance | 528 | 0.87 |
| Double-A | pitcher | minSample 75 | 580 | 0.84 |
| Double-A | pitcher | minSample 150 | 442 | 0.71 |
| Double-A | pitcher | without age vs level | 580 | 0.40 |
| Double-A | pitcher | Mahalanobis distance | 580 | 0.80 |
| High-A | hitter | minSample 75 | 524 | 0.87 |
| High-A | hitter | minSample 150 | 413 | 0.76 |
| High-A | hitter | without age vs level | 524 | 0.45 |
| High-A | hitter | Mahalanobis distance | 524 | 0.84 |
| High-A | pitcher | minSample 75 | 572 | 0.83 |
| High-A | pitcher | minSample 150 | 442 | 0.72 |
| High-A | pitcher | without age vs level | 572 | 0.41 |
| High-A | pitcher | Mahalanobis distance | 572 | 0.77 |
| Single-A | hitter | minSample 75 | 508 | 0.79 |
| Single-A | hitter | minSample 150 | 392 | 0.73 |
| Single-A | hitter | without age vs level | 508 | 0.44 |
| Single-A | hitter | Mahalanobis distance | 508 | 0.84 |
| Single-A | pitcher | minSample 75 | 561 | 0.80 |
| Single-A | pitcher | minSample 150 | 407 | 0.66 |
| Single-A | pitcher | without age vs level | 561 | 0.38 |
| Single-A | pitcher | Mahalanobis distance | 561 | 0.78 |

## 6. Criteria detail

**Triple-A hitters** (as of 2026-09-20, level median age 26.7)

- C1 **pass**: Split-half overlap ≥ 3 × chance and above the single-stat baseline. overlap 0.177 vs chance 0.027 (×6.7), closest OPS 0.030.
- C2 fail: Holdout: similar players lower the prediction error beyond the player's own rate (90% interval > 0). improvement 0.0028 [-0.0023, 0.0080] over 3 cutoffs.
- C3 review: Face validity: no systematic mismatch class. baseball-analyst review (see the report section and the appendix).
- C4 **pass**: At least 50 qualified players. 558 qualified (≥ 100 PA).

**Triple-A pitchers** (as of 2026-09-20, level median age 27.8)

- C1 **pass**: Split-half overlap ≥ 3 × chance and above the single-stat baseline. overlap 0.253 vs chance 0.033 (×7.7), closest K−BB% 0.024.
- C2 fail: Holdout: similar players lower the prediction error beyond the player's own rate (90% interval > 0). improvement 0.0015 [-0.0024, 0.0053] over 3 cutoffs.
- C3 review: Face validity: no systematic mismatch class. baseball-analyst review (see the report section and the appendix).
- C4 **pass**: At least 50 qualified players. 617 qualified (≥ 100 BF).

**Double-A hitters** (as of 2026-09-13, level median age 24.4)

- C1 **pass**: Split-half overlap ≥ 3 × chance and above the single-stat baseline. overlap 0.194 vs chance 0.030 (×6.5), closest OPS 0.033.
- C2 fail: Holdout: similar players lower the prediction error beyond the player's own rate (90% interval > 0). improvement 0.0013 [-0.0013, 0.0041] over 3 cutoffs.
- C3 review: Face validity: no systematic mismatch class. baseball-analyst review (see the report section and the appendix).
- C4 **pass**: At least 50 qualified players. 528 qualified (≥ 100 PA).

**Double-A pitchers** (as of 2026-09-13, level median age 25.5)

- C1 **pass**: Split-half overlap ≥ 3 × chance and above the single-stat baseline. overlap 0.249 vs chance 0.035 (×7.1), closest K−BB% 0.059.
- C2 **pass**: Holdout: similar players lower the prediction error beyond the player's own rate (90% interval > 0). improvement 0.0144 [0.0038, 0.0245] over 3 cutoffs.
- C3 review: Face validity: no systematic mismatch class. baseball-analyst review (see the report section and the appendix).
- C4 **pass**: At least 50 qualified players. 580 qualified (≥ 100 BF).

**High-A hitters** (as of 2026-09-06, level median age 22.9)

- C1 **pass**: Split-half overlap ≥ 3 × chance and above the single-stat baseline. overlap 0.220 vs chance 0.032 (×6.9), closest OPS 0.032.
- C2 fail: Holdout: similar players lower the prediction error beyond the player's own rate (90% interval > 0). improvement 0.0052 [-0.0046, 0.0144] over 3 cutoffs.
- C3 review: Face validity: no systematic mismatch class. baseball-analyst review (see the report section and the appendix).
- C4 **pass**: At least 50 qualified players. 524 qualified (≥ 100 PA).

**High-A pitchers** (as of 2026-09-06, level median age 24.0)

- C1 **pass**: Split-half overlap ≥ 3 × chance and above the single-stat baseline. overlap 0.250 vs chance 0.036 (×6.9), closest K−BB% 0.046.
- C2 fail: Holdout: similar players lower the prediction error beyond the player's own rate (90% interval > 0). improvement -0.0002 [-0.0014, 0.0010] over 2 cutoffs.
- C3 review: Face validity: no systematic mismatch class. baseball-analyst review (see the report section and the appendix).
- C4 **pass**: At least 50 qualified players. 572 qualified (≥ 100 BF).

**Single-A hitters** (as of 2026-09-06, level median age 21.7)

- C1 **pass**: Split-half overlap ≥ 3 × chance and above the single-stat baseline. overlap 0.209 vs chance 0.032 (×6.5), closest OPS 0.030.
- C2 **pass**: Holdout: similar players lower the prediction error beyond the player's own rate (90% interval > 0). improvement 0.0106 [0.0029, 0.0183] over 2 cutoffs.
- C3 review: Face validity: no systematic mismatch class. baseball-analyst review (see the report section and the appendix).
- C4 **pass**: At least 50 qualified players. 508 qualified (≥ 100 PA).

**Single-A pitchers** (as of 2026-09-06, level median age 22.9)

- C1 **pass**: Split-half overlap ≥ 3 × chance and above the single-stat baseline. overlap 0.278 vs chance 0.039 (×7.2), closest K−BB% 0.044.
- C2 fail: Holdout: similar players lower the prediction error beyond the player's own rate (90% interval > 0). improvement 0.0038 [-0.0013, 0.0092] over 2 cutoffs.
- C3 review: Face validity: no systematic mismatch class. baseball-analyst review (see the report section and the appendix).
- C4 **pass**: At least 50 qualified players. 561 qualified (≥ 100 BF).


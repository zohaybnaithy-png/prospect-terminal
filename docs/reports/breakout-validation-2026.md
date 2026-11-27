# Breakout validation report (T-405)

Method: docs/BREAKOUT-METHOD.md (approved D-021). Source: build-time snapshot .data-snapshot/ (season 2026) (snapshot 8b418063511b).
Settings: approved defaults (statistic shrunk-over-raw-se, blocks 100/100, q 0.1, standing 70th pct, persistence 2 of 3).
Seed 20261126; null runs per level 1000; churn evaluated every completed date.

## Verdict (§7)

| Level | Role | Result | Failed criteria |
|---|---|---|---|
| Triple-A | hitter | fail | Retention ≥ 0.5; Above matched controls (90% CI excludes 0); Retention above both naive baselines; Churn ≤ 20%; ≥ 10 flags at every cutoff |
| Triple-A | pitcher | fail | Retention ≥ 0.5; Above matched controls (90% CI excludes 0); Retention above both naive baselines; Churn ≤ 20%; ≥ 10 flags at every cutoff |
| Double-A | hitter | fail | Retention ≥ 0.5; Above matched controls (90% CI excludes 0); Retention above both naive baselines; Churn ≤ 20%; ≥ 10 flags at every cutoff |
| Double-A | pitcher | fail | Retention ≥ 0.5; Above matched controls (90% CI excludes 0); Retention above both naive baselines; Churn ≤ 20%; ≥ 10 flags at every cutoff |
| High-A | hitter | fail | Retention ≥ 0.5; Above matched controls (90% CI excludes 0); Retention above both naive baselines; Churn ≤ 20%; ≥ 10 flags at every cutoff |
| High-A | pitcher | fail | Retention ≥ 0.5; Above matched controls (90% CI excludes 0); Retention above both naive baselines; Churn ≤ 20%; ≥ 10 flags at every cutoff |
| Single-A | hitter | fail | Retention ≥ 0.5; Above matched controls (90% CI excludes 0); Retention above both naive baselines; Churn ≤ 20%; ≥ 10 flags at every cutoff |
| Single-A | pitcher | fail | Retention ≥ 0.5; Above matched controls (90% CI excludes 0); Retention above both naive baselines; Churn ≤ 20%; ≥ 10 flags at every cutoff |

A level/role that fails shows "Breakout detection is not available at this level". Thresholds are not loosened after seeing these results (§7).

## Triple-A — hitters

### Reliability (§6.1)

| Metric | Players | Split-half r | k (90% CI) | Reliability at 100 | Used |
|---|---|---|---|---|---|
| K% | 387 | 0.72 | 67 (54–82) | 0.60 | yes |
| BB% | 387 | 0.51 | 163 (124–220) | 0.38 | yes |
| ISO | 387 | 0.43 | 199 (149–272) | 0.30 | yes |

### Criteria (§7)

| Criterion | Value | Pass |
|---|---|---|
| Null: ≤ 1 false flag per date | 0.01 | yes |
| Retention ≥ 0.5 | n/a | no |
| Above matched controls (90% CI excludes 0) | n/a [n/a, n/a], n=0 | no |
| Retention above both naive baselines | n/a vs Momentum n/a, results n/a (post gain n/a vs n/a, n/a) | no |
| Churn ≤ 20% | n/a (0/0) | no |
| ≥ 10 flags at every cutoff | 0 / 0 / 0 | no |

### Holdout by cutoff (§6.3)

| Cutoff | Qualified | Breakout | Watch | Retention (with post) | Flagged − controls (90% CI) | Momentum 30D | Recent results | Promoted ≤45d |
|---|---|---|---|---|---|---|---|---|
| 2026-06-15 | 154 | 0 | 6 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |
| 2026-07-15 | 246 | 0 | 12 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |
| 2026-08-15 | 312 | 0 | 18 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |

Null calibration (§6.2): 0.011 flags per date on shuffled data (1000 runs × 4 dates).
Churn (§6.4): 0 of 0 flag spells ended within 14 days.
ISO standard error: linearized / bootstrap median ratio 1.02 over 50 players.

## Triple-A — pitchers

### Reliability (§6.1)

| Metric | Players | Split-half r | k (90% CI) | Reliability at 100 | Used |
|---|---|---|---|---|---|
| K% | 325 | 0.58 | 114 (89–147) | 0.47 | yes |
| BB% | 325 | 0.52 | 147 (113–194) | 0.40 | yes |

### Criteria (§7)

| Criterion | Value | Pass |
|---|---|---|
| Null: ≤ 1 false flag per date | 0.02 | yes |
| Retention ≥ 0.5 | n/a | no |
| Above matched controls (90% CI excludes 0) | n/a [n/a, n/a], n=0 | no |
| Retention above both naive baselines | n/a vs Momentum n/a, results n/a (post gain n/a vs n/a, n/a) | no |
| Churn ≤ 20% | n/a (0/0) | no |
| ≥ 10 flags at every cutoff | 0 / 0 / 0 | no |

### Holdout by cutoff (§6.3)

| Cutoff | Qualified | Breakout | Watch | Retention (with post) | Flagged − controls (90% CI) | Momentum 30D | Recent results | Promoted ≤45d |
|---|---|---|---|---|---|---|---|---|
| 2026-06-15 | 62 | 0 | 3 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |
| 2026-07-15 | 133 | 0 | 3 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |
| 2026-08-15 | 217 | 0 | 5 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |

Null calibration (§6.2): 0.021 flags per date on shuffled data (1000 runs × 4 dates).
Churn (§6.4): 0 of 0 flag spells ended within 14 days.

## Double-A — hitters

### Reliability (§6.1)

| Metric | Players | Split-half r | k (90% CI) | Reliability at 100 | Used |
|---|---|---|---|---|---|
| K% | 340 | 0.71 | 70 (57–87) | 0.59 | yes |
| BB% | 340 | 0.60 | 117 (94–148) | 0.46 | yes |
| ISO | 340 | 0.50 | 148 (112–204) | 0.37 | yes |

### Criteria (§7)

| Criterion | Value | Pass |
|---|---|---|
| Null: ≤ 1 false flag per date | 0.01 | yes |
| Retention ≥ 0.5 | n/a | no |
| Above matched controls (90% CI excludes 0) | n/a [n/a, n/a], n=0 | no |
| Retention above both naive baselines | n/a vs Momentum n/a, results n/a (post gain n/a vs n/a, n/a) | no |
| Churn ≤ 20% | 100% (1/1) | no |
| ≥ 10 flags at every cutoff | 0 / 0 / 0 | no |

### Holdout by cutoff (§6.3)

| Cutoff | Qualified | Breakout | Watch | Retention (with post) | Flagged − controls (90% CI) | Momentum 30D | Recent results | Promoted ≤45d |
|---|---|---|---|---|---|---|---|---|
| 2026-06-15 | 133 | 0 | 7 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |
| 2026-07-15 | 225 | 0 | 9 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |
| 2026-08-15 | 276 | 0 | 12 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |

Null calibration (§6.2): 0.015 flags per date on shuffled data (1000 runs × 4 dates).
Churn (§6.4): 1 of 1 flag spells ended within 14 days.
ISO standard error: linearized / bootstrap median ratio 1.03 over 50 players.

## Double-A — pitchers

### Reliability (§6.1)

| Metric | Players | Split-half r | k (90% CI) | Reliability at 100 | Used |
|---|---|---|---|---|---|
| K% | 319 | 0.63 | 92 (74–118) | 0.52 | yes |
| BB% | 319 | 0.61 | 102 (74–144) | 0.49 | yes |

### Criteria (§7)

| Criterion | Value | Pass |
|---|---|---|
| Null: ≤ 1 false flag per date | 0.01 | yes |
| Retention ≥ 0.5 | n/a | no |
| Above matched controls (90% CI excludes 0) | n/a [n/a, n/a], n=0 | no |
| Retention above both naive baselines | n/a vs Momentum n/a, results n/a (post gain n/a vs n/a, n/a) | no |
| Churn ≤ 20% | n/a (0/0) | no |
| ≥ 10 flags at every cutoff | 0 / 0 / 0 | no |

### Holdout by cutoff (§6.3)

| Cutoff | Qualified | Breakout | Watch | Retention (with post) | Flagged − controls (90% CI) | Momentum 30D | Recent results | Promoted ≤45d |
|---|---|---|---|---|---|---|---|---|
| 2026-06-15 | 70 | 0 | 9 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |
| 2026-07-15 | 130 | 0 | 6 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |
| 2026-08-15 | 237 | 0 | 11 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |

Null calibration (§6.2): 0.009 flags per date on shuffled data (1000 runs × 4 dates).
Churn (§6.4): 0 of 0 flag spells ended within 14 days.

## High-A — hitters

### Reliability (§6.1)

| Metric | Players | Split-half r | k (90% CI) | Reliability at 100 | Used |
|---|---|---|---|---|---|
| K% | 326 | 0.72 | 66 (53–82) | 0.60 | yes |
| BB% | 326 | 0.65 | 89 (70–115) | 0.53 | yes |
| ISO | 326 | 0.50 | 141 (106–194) | 0.38 | yes |

### Criteria (§7)

| Criterion | Value | Pass |
|---|---|---|
| Null: ≤ 1 false flag per date | 0.02 | yes |
| Retention ≥ 0.5 | n/a | no |
| Above matched controls (90% CI excludes 0) | n/a [n/a, n/a], n=0 | no |
| Retention above both naive baselines | n/a vs Momentum n/a, results n/a (post gain n/a vs n/a, n/a) | no |
| Churn ≤ 20% | n/a (0/0) | no |
| ≥ 10 flags at every cutoff | 0 / 0 / 0 | no |

### Holdout by cutoff (§6.3)

| Cutoff | Qualified | Breakout | Watch | Retention (with post) | Flagged − controls (90% CI) | Momentum 30D | Recent results | Promoted ≤45d |
|---|---|---|---|---|---|---|---|---|
| 2026-06-15 | 150 | 0 | 13 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |
| 2026-07-15 | 231 | 0 | 13 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |
| 2026-08-15 | 292 | 0 | 18 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |

Null calibration (§6.2): 0.020 flags per date on shuffled data (1000 runs × 4 dates).
Churn (§6.4): 0 of 0 flag spells ended within 14 days.
ISO standard error: linearized / bootstrap median ratio 1.01 over 50 players.

## High-A — pitchers

### Reliability (§6.1)

| Metric | Players | Split-half r | k (90% CI) | Reliability at 100 | Used |
|---|---|---|---|---|---|
| K% | 308 | 0.54 | 128 (97–170) | 0.44 | yes |
| BB% | 308 | 0.47 | 166 (124–233) | 0.38 | yes |

### Criteria (§7)

| Criterion | Value | Pass |
|---|---|---|
| Null: ≤ 1 false flag per date | 0.01 | yes |
| Retention ≥ 0.5 | n/a | no |
| Above matched controls (90% CI excludes 0) | n/a [n/a, n/a], n=0 | no |
| Retention above both naive baselines | n/a vs Momentum n/a, results n/a (post gain n/a vs n/a, n/a) | no |
| Churn ≤ 20% | n/a (0/0) | no |
| ≥ 10 flags at every cutoff | 0 / 0 / 0 | no |

### Holdout by cutoff (§6.3)

| Cutoff | Qualified | Breakout | Watch | Retention (with post) | Flagged − controls (90% CI) | Momentum 30D | Recent results | Promoted ≤45d |
|---|---|---|---|---|---|---|---|---|
| 2026-06-15 | 56 | 0 | 1 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |
| 2026-07-15 | 136 | 0 | 9 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |
| 2026-08-15 | 228 | 0 | 8 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |

Null calibration (§6.2): 0.014 flags per date on shuffled data (1000 runs × 4 dates).
Churn (§6.4): 0 of 0 flag spells ended within 14 days.

## Single-A — hitters

### Reliability (§6.1)

| Metric | Players | Split-half r | k (90% CI) | Reliability at 100 | Used |
|---|---|---|---|---|---|
| K% | 317 | 0.80 | 41 (33–51) | 0.71 | yes |
| BB% | 317 | 0.64 | 92 (71–122) | 0.52 | yes |
| ISO | 317 | 0.46 | 165 (123–233) | 0.34 | yes |

### Criteria (§7)

| Criterion | Value | Pass |
|---|---|---|
| Null: ≤ 1 false flag per date | 0.02 | yes |
| Retention ≥ 0.5 | n/a | no |
| Above matched controls (90% CI excludes 0) | n/a [n/a, n/a], n=0 | no |
| Retention above both naive baselines | n/a vs Momentum n/a, results n/a (post gain n/a vs n/a, n/a) | no |
| Churn ≤ 20% | 100% (3/3) | no |
| ≥ 10 flags at every cutoff | 0 / 0 / 0 | no |

### Holdout by cutoff (§6.3)

| Cutoff | Qualified | Breakout | Watch | Retention (with post) | Flagged − controls (90% CI) | Momentum 30D | Recent results | Promoted ≤45d |
|---|---|---|---|---|---|---|---|---|
| 2026-06-15 | 127 | 0 | 7 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |
| 2026-07-15 | 223 | 0 | 15 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |
| 2026-08-15 | 286 | 0 | 17 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |

Null calibration (§6.2): 0.022 flags per date on shuffled data (1000 runs × 4 dates).
Churn (§6.4): 3 of 3 flag spells ended within 14 days.
ISO standard error: linearized / bootstrap median ratio 1.02 over 50 players.

## Single-A — pitchers

### Reliability (§6.1)

| Metric | Players | Split-half r | k (90% CI) | Reliability at 100 | Used |
|---|---|---|---|---|---|
| K% | 282 | 0.53 | 129 (96–179) | 0.44 | yes |
| BB% | 282 | 0.64 | 84 (65–109) | 0.54 | yes |

### Criteria (§7)

| Criterion | Value | Pass |
|---|---|---|
| Null: ≤ 1 false flag per date | 0.02 | yes |
| Retention ≥ 0.5 | n/a | no |
| Above matched controls (90% CI excludes 0) | n/a [n/a, n/a], n=0 | no |
| Retention above both naive baselines | n/a vs Momentum n/a, results n/a (post gain n/a vs n/a, n/a) | no |
| Churn ≤ 20% | n/a (0/0) | no |
| ≥ 10 flags at every cutoff | 0 / 0 / 0 | no |

### Holdout by cutoff (§6.3)

| Cutoff | Qualified | Breakout | Watch | Retention (with post) | Flagged − controls (90% CI) | Momentum 30D | Recent results | Promoted ≤45d |
|---|---|---|---|---|---|---|---|---|
| 2026-06-15 | 42 | 0 | 2 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |
| 2026-07-15 | 139 | 0 | 2 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |
| 2026-08-15 | 224 | 0 | 6 | n/a (0) | n/a [n/a, n/a] n=0 | n/a (0) | n/a (0) | 0 |

Null calibration (§6.2): 0.016 flags per date on shuffled data (1000 runs × 4 dates).
Churn (§6.4): 0 of 0 flag spells ended within 14 days.

## Notes

- Shrinkage constants k come from the full season at each level (a population reliability constant); the detector at each cutoff otherwise uses only games on or before the cutoff.
- ISO's standard error uses the linearized game-cluster ratio variance instead of a per-player bootstrap (§4.3), for speed; the ratio above checks the two agree.
- The permutation null used for p-values is rebuilt every 7 days from the data available on that date (§6.2).
- Pitcher "recent results" baseline uses recent-block ERA (pitchers have no OPS).
- Retention is a ratio of sums, Σ(post − earlier) / Σ(recent − earlier); it is n/a when a group's mean recent gain is below 0.1 SD (nothing to retain). Criterion 3 then compares mean post-cutoff gain instead.

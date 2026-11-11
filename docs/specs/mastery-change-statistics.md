# Mastery change statistics

Status and live numbers: [mastery-notifications-status.md](mastery-notifications-status.md), section "Mastery change statistics".
Code: `packages/core/src/lib/learning/mastery-change-statistics.ts` (pure, unit-tested), `grader-noise.ts`,
`mastery-change.ts` (reads), `packages/server/src/functions/learning/mastery-statistics.function.ts` (RPCs),
`mastery-known-truth.ts` (the known-truth simulator and its calibration), migrations
`0022_mastery_statistics.sql`, `0031_prior_blind_measurement.sql`.

The question this answers: **is the learner's mastery going up, down, or not detectably anywhere,
and does teaching a concept move it more than not teaching it?** The existing feed answers a
different question ("tell me about gains") and is positive-only by design; these numbers are signed,
include declines, and always carry an interval.

## Inputs

A **counted reading** is a row of `learning_mastery_readings` that is independent (one per origin;
`unchanged` copies dropped, as in the feed), at medium or high confidence, with a percent. Readings
are ordered by **`evidence_at`** (when the learner said it, migration 0018), never by grading time:
a backlog graded today says nothing about today.

## A. The grader's two errors (review B1, B2; migration 0031)

The live v6 grader **revises its own published estimate**: its prompt carries a
`### CURRENT PUBLISHED ESTIMATE` section. Measured on dev (2026-11-11, live model
`codex/gpt-5.6-luna/xhigh`, `scripts/mastery-grader-calibration.ts`):

| | |
|---|---|
| Anchored gradings vs their prior (n = 4,113) | equal 72.3 %, up 27.4 %, down 0.3 %; mean move **+2.15** per grading |
| Regrade sd, same evidence and same numeric prior (501 df) | **2.26** |
| Regrade sd, same evidence, no prior in the prompt (329 df) | **6.74** |
| Anchored move by gap G = blind grade − prior | G −50: +0.6 · G −7: +2.5 · G +2.5: +3.6 · G +12: +7.3 · G +22: +12.4 |

So a live score follows its prior (slope 0.94), rises a little whatever the evidence says, follows a
positive gap only partly, and almost never goes down. Its error is not "truth + noise": it is a
**path** that ratchets up with the number of gradings. In simulation (below) the live scores rise
about +20 points over eight weeks with **no learning at all**. The old σ = 11.84 mixed this drift
with noise and is retired.

A **prior-blind** grading (no numeric prior in the prompt) is truth + independent noise. Every
verdict below rests on prior-blind measurements only:

- **Sources.** A concept's first grading (its prompt has no estimate) and every **replicate**: since
  0031 a replicate regrades the run's evidence with the estimate withheld (`priorBlindPrompt` replaces
  the section's line with `none`; nothing else in the prompt changes, tested).
- **Recording.** The digest records the numeric prior a run's prompt carried (`prior_percent`, null =
  prior-blind), backfilled from the snapshots. The view's `understanding_percent` is the live grading,
  never averaged; `blind_percent`, `blind_gradings`, `blind_confidence`, `blind_sd` describe the
  reading's prior-blind measurement (the replicate summary, plus the run's own grading when it was
  prior-blind). The published estimate (the cache) is the live grading too.
- **Noise components** (`graderNoise`): `blind` pools prior-blind regrades of identical evidence and
  every replicate summary's spread (live model only); `anchored` pools regrades that share the same
  numeric prior; `drift` is every anchored grading's move from its prior. Pooled within-group sd
  `sqrt(Σ(n_i−1)s_i² / Σ(n_i−1))`, unbiased for σ² (a pair's sd is biased low). Below 30 df the
  measured fallbacks (6.74, 2.26) are used and reported as `fallback`.
- **The live scores** are shown as what they are: "your scores (each grading starts from the previous
  score) moved +X over N gradings; the grader alone raises a score about +2.1 per grading (+Y here),
  so they are not evidence of learning". They carry no verdict.
- **Correlation.** Gradings of one prompt are independent draws; gradings from different runs dated
  at one time share evidence (ρ ≈ 0.34 on dev), so a measurement of k such gradings counts as
  `k / (1 + (k−1)ρ)` (`effectiveGradings`, review S7).
- **Grid.** A single grading is on a 5-point grid (rounding variance 25/12, already inside the
  measured sd). Concepts with a measurement at 0 or 100 are counted (`atBound`).

**Consequence at the default policy (k = 1).** Only first gradings are prior-blind, so a concept is
never measured prior-blind twice and **no verdict is given**: the line says "No concept is measured
twice without the previous score yet". Verdicts need `gradingReplicates` ≥ 2 (cost in B). This is
the honest state, not a defect to hide: the old verdicts read the ratcheting series.

## A. Per-concept change (prior-blind)

- `from` / `to`: the first and last prior-blind measurement (by evidence time). With `sinceDays`,
  `from` is the last measurement **before** the window and the concept needs one inside it.
- `delta = to − from`, `se = σ_b·√(1/k_from + 1/k_to)` (k effective), two-sided `pValue`.
- `beyondNoise`: **Benjamini–Hochberg** at FDR 0.05 across the concepts reported together (review S3);
  the unadjusted count and the count chance alone gives (5 % of the concepts) are reported beside it.
- `slopePerWeek`: weighted least squares on evidence weeks, weights = effective gradings, `se = σ/√Sxx`.
- `gradingsBetween`: live gradings of the concept between the two measurements (the opportunity count).

## A. Aggregate

- **Mean change and mean slope**: DerSimonian–Laird random-effects mean over concepts.
- **95 % interval**: `estimate ± t₀.₉₇₅(n−1) · se_boot · √(n/(n−1))`, se_boot from 2,000 bootstrap
  resamples over concepts (fixed seed). The percentile bootstrap undercovered at small n (review N2);
  the t-widened interval covers a true zero 92–98 % of the time at n = 20 (tested). **No interval
  below 20 concepts** (review S2): the line says "not enough data for an interval (20 concepts needed)".
- **Verdict wording** (review S1): "readings rose beyond grader noise (not proof of learning:
  regression to the mean and which concepts get read can do this)"; "readings fell beyond grader
  noise (one grader's readings can fall with no change in understanding)"; else "not distinguishable
  from no change". Never "a real gain".
- **Limits.** Concepts are the ones the learner kept talking about, not a random sample; regression to
  the mean pulls a concept first read low upward. Only the holdout's probe estimate (C) separates
  teaching from that.

## A. Gain rule (toast and strip)

A gain is a counted prior-blind measurement above the **mean** of the concept's earlier counted
prior-blind measurements (review S11: the maximum made a gain harder to announce the more often a
concept was read) by

    max(GAIN_MIN_POINTS, 1.645 · σ_b · √(1/k_now + 1/k_before) + 2.5 / lcm(k_now, k_before))

one-sided 95 % on the variance of a difference of two independent means. The last term is the
continuity correction for the grid: a mean of k gridded gradings moves in steps of 5/k, so without it
k_now 1 against k_before 4 fires 5.8 % of the time under no change (the threshold 12.4 sits just
below the reachable 12.5); with it every combination of k_now ≤ 3, k_before ≤ 10 fires ≤ 5 % (tested).
The +10 floor is a product rule and takes no correction. At σ_b = 6.74 a single blind grading must
rise +20 over a single earlier one; over the mean of three earlier, +15. SQL `BLIND_GAIN` and pure
`isBlindGain` are twins (tested on 400 cases). A live (anchored) rise is never a gain.

## A. Notifications vs statistics

A toast says "you improved just now"; the statistics say what happened, whenever it was graded.
They use the same readings under different rules (review findings 2–4, 10):

| | Toast (feed) | Statistics, strip, holdout |
|---|---|---|
| Unit | one reading, in the order readings went live | a **measurement**: gradings of a concept dated at the same time, averaged (weighted by gradings); a regrade is a replicate, never a gain |
| Uncited reading | sets a level, never toasted, never moves the frontier | counts, dated by the 75th percentile of its learner messages |
| Must cite | a **learner** message (agent text does not count) | — |
| Newness | that message strictly newer than every cited learner message already shown | — |
| Recency | that message at most 7 days old when the reading goes live (`TOAST_RECENCY_DAYS`) | — (backfill lands in its evidence week) |
| Size | the gain rule above, over the counted blind measurements already live | the strip's ▲ up: the same rule over blind measurements on older evidence, cited measurements only |

**When the feed is quiet (review S10).** The recency rule compares the cited message with the time
the reading goes live, so while the grader works through a backlog nothing can pass it, whatever the
learner does (dev, October 2026: 2 of 189 cited readings graded within 7 days; median lag 44.7 days).
The rule stays, because a toast says "just now". Beside it, `getMasteryChanges.feed` (`feedHealth`)
reports, over the counted cited readings that went live in the last 14 days, how many there were, how
many passed the recency rule, how many were news, and the median lag from cited message to going live.
The page's feed line says "grading is running about N days behind your messages, so the feed stays
quiet until it catches up" when that lag exceeds the recency window, so silence is never read as "no
progress".

**Dating uncited readings.** About a third of counted readings cite nothing and used to be dated by
the newest learner message in their evidence set. An uncited reading is dated by the 75th percentile
of its learner messages instead. The rule can only be scored where the answer is known, on cited
readings against the newest learner message they cite, so `scripts/uncited-dating-evaluation.ts`
(pure part: `uncited-dating.ts`, tested) publishes the scoring and
`packages/core/src/lib/learning/data/uncited-dating-evaluation.json` holds dev's numbers
(2026-11-11: 309 cited, 154 uncited readings). Days, dated minus cited:

| | bias | median abs. error | mean abs. error |
|---|---|---|---|
| newest message (the old rule), in sample | +10.9 | 1.62 | 10.9 |
| 75th percentile, in sample | +2.23 | 0.64 | 5.11 |
| 75th percentile, transferred to uncited-like readings | +1.45 | 0.06 | 3.43 |

- **In sample vs held out (review "(c)").** Choosing the quantile with the least |bias| on a random
  half and scoring it on the other half (2,000 splits) picks 0.6 in 49 % of splits, 0.7 in 29 %,
  0.75 in 17 %; the held-out bias is −0.44 d (95 % −2.9 to +6.0). The candidates from 0.6 to 0.8
  are indistinguishable within that spread, and re-picking on the same readings would repeat the
  optimism this measures, so the rule stays at 0.75.
- **Transfer (review N7).** The rule is applied to readings unlike the ones it is scored on
  (uncited: median 5 learner messages over 4.1 days; cited: 12 over 4.4). Cited readings are cut
  down to uncited shapes: for each of 5,000 draws, a real uncited reading's message count and span,
  and a run of that many consecutive learner messages of a cited reading that holds the cited
  message and spans within max(0.5 d, 25 %) of it (4,891 matched; median span 3.3 d). On those the
  rule is a few hours off for most readings and about 1.5 days late on average, with a heavy tail.
- **Consequence.** An uncited reading enters the change statistic as a level, dated about 1.5 days
  late on average; it never establishes a toast, and it is never a probe answer (S-A: a probe's
  two-minute window needs the learner's own clock).

## B. Replicate grading

Policy setting `gradingReplicates` (1–5, default 1). k = 1 writes exactly what it wrote before (readings,
receipts and the assessment cache are byte-identical; tested); the only difference is one recorded
no-op plan step in each workflow's history. **The statistics' verdicts need k ≥ 2** (A): at k = 1 no
concept is ever measured prior-blind twice. Raising the default is the owner's call (cost below).

With k > 1, after the primary grading (manual: the run; reactive pass: the last assessed part,
which is the part that becomes the reading) the workflow runs k − 1 replicate steps, each its own
durable step with its own receipt in `learning_concept_assessment_replicates`. A step reserves its
row before calling the model; a replay finds the receipt and does not call again, and a reservation
without a receipt (the process died mid-call) is recorded `uncertain`, never retried, so nothing is
paid twice. A plan row hides the reading from the view until the combine step writes the summary:

- since 0031 each replicate is **prior-blind** (the estimate withheld, A); the reading stays the live
  grading and the summary is its prior-blind measurement: the **raw mean** of the blind gradings
  (the replicates, plus the run's own grading when it was prior-blind), grid value for display only;
- spread stored (sd, min, max); tokens and duration summed over every grading of the run;
- confidence = the **median** of the blind gradings' (the lower middle when k is even). Review S6:
  the weakest made a reading's counted status, and so its level, depend on k;
- a replicate step that finds its reservation without a receipt stamps it `uncertain` and never pays
  again; the call still running when that happened (a duplicate delivery, a retried step) replaces
  the stamp with its receipt when it lands (review S5, tested).

Measured cost (dev, gradings of the live model, 2026-10-21 → 10-30): a reactive reading costs on
average 174k input / 4.1k output tokens over 3.7 parts (41 s of model time); its last part is 46k /
0.93k (10.2 s, p90 20 s). **k = 3 adds two last-part calls: +93k input, +1.9k output tokens, +20 s
per reading (+53 % input tokens).** The grader runs on a subscription with no per-token bill;
Langfuse prices the usage. Not enabled on dev.

## C. Holdout analysis

Experiment `osmosis-concept-holdout`: a concept is held out (never taught, reviewed or used as an
anchor) when `md5(concept id)` falls in bucket 0 of 5, i.e. **1 in 5, a constant** (owner decision,
2026-11-11: not a setting). The assignment is a pure function of the id with an SQL twin. The
experiment is recorded in `learning_holdout_phases` (migration 0022): one row, phase 1, 1 in 5, from
2026-10-30T18:05Z. Nothing writes a new phase; the analysis refuses to run if the record and the
code's share ever disagree.

- **Units.** Per concept: baseline = the last prior-blind measurement with evidence **before** the phase
  start; follow-up = the latest after the start. A concept first measured after the start has no
  baseline untouched by teaching and is left out, counted per arm as `noPreStartBaseline` (review S9);
  `measuredTwiceShare` per arm is 1 − attrition.
- **Effect: ANCOVA**, OLS of follow-up on [1, baseline, taught]; the taught coefficient. Chosen over
  the change score because assignment is randomized: ANCOVA is unbiased then even with a noisy
  baseline, and its variance is never above the change score's (a simulation test checks both). The
  interval is the t-widened stratified bootstrap (A).
- **Three estimates** (review B2). The **headline** is over prior-blind **probe answers**: probes
  reach both arms alike, so it is the equal-opportunity comparison and the only one that may say
  "taught concepts scored higher on probes beyond grader noise". Its follow-up is each concept's
  **first** probe answer after the start, not the latest: a held-out concept is probed about four
  times as often (blind-probes.md, round 5 B-1) and being asked is practice, so a later answer
  carries more testing in the held-out arm (a test with +3 per probe turns a +5 effect negative when
  the latest answer is used). The estimate over **all** prior-blind
  measurements is opportunistic (a taught concept is read more often) and carries no verdict; it
  reports the live gradings between baseline and follow-up per arm. The **anchored** estimate (live
  scores) adds that gradings count as a covariate, because each grading ratchets the score: with no
  teaching effect and taught concepts graded 6× to 1×, the unadjusted effect is about +10 and the
  adjusted one about 0 (tested).
- **Minimum.** No estimate until 20 concepts per arm are measured twice: the line says
  "setting baseline: X of 20 held-out concepts measured twice".
- **Power.** `MDE = (1.96 + 0.84)·s·√(1/n_t + 1/n_h)` at 80 % power, two-sided α 0.05, with `s` the
  ANCOVA residual sd; before the arms can be fitted, the residual of follow-up on baseline over every
  concept measured twice. Concepts needed to detect 5 points: `n = (1.96+0.84)²·s² / (5²·p(1−p))`;
  the pace (concepts newly measured twice per week over the last four) gives the weeks still needed.
- **Probes** ([blind-probes.md](blind-probes.md), migration 0023). A measurement is a probe answer by
  the rule the probe analysis scores probes with (`probeAnswerEvidenceSql`, review S-A): its
  `evidence_at` falls after a delivered probe of that concept
  (`learning_live_feedback_turns.probe_concept_id`) and no later than 2 minutes after the next live
  turn of the same session began, and that next turn did not teach the concept (`taughtConceptIds`).
  The bound is on the learner's clock, so only a measurement dated by a cited learner message
  qualifies (`learner_dated`): never one dated by its grading (`graded`), by an uncited reading's
  75th-percentile proxy (`evidence_set`, median error 0.6 d), or by a cited agent message. `probe` is
  null while no measurement is a probe answer (the `blindProbes` switch is off today).
- **GrowthBook** (migration 0032, `mastery-holdout-growthbook.ts`). The experiment
  `exp_bkhj8zimvvaf8ar` analyses the headline estimand, not the live readings. Fact table
  `ftb_bkhj8zimwc6mqyc` (SQL from `holdoutProbeFactSql`) has, per concept with a pre-start baseline,
  its first prior-blind probe answer after the start and its last prior-blind measurement before it.
  It reads `learning_blind_measurements(user)`, a SECURITY DEFINER copy of MEASUREMENTS + the probe
  rule: GrowthBook's read-only role may run it but cannot read the tables carrying the learner's
  messages. Goal metric `fact__2CgwFsKckcfrdBssncU52i` is a ratio, sum(probe_percent) /
  sum(probe_answer). A plain mean would score an unprobed concept 0, and held-out concepts are
  probed more often. Regression adjustment with a 365-day lookback takes the baseline as covariate,
  which is GrowthBook's form of the ANCOVA. The two live-reading metrics are kept as secondary and
  are labelled descriptive. `mastery-holdout-growthbook.integration.test.ts` checks that the function
  equals `countedMeasurements().blind` and that the fact rows equal `holdoutUnits(…, 'first')`. A
  change to MEASUREMENTS or to the probe rule fails it, and needs a migration replacing the function.
- **Limit.** Held-out concepts are still talked about by the learner, only not taught, so the effect
  is "teaching on top of exposure". Readings are opportunistic: a taught concept is more likely to be
  read again, which the probe estimate exists to check.

## Known-truth recovery and the permanent null test

`mastery-known-truth.ts` plants a learner's true trajectory and grades it with a simulated grader
calibrated on the live one (`data/mastery-grader-calibration.json`, numbers only): prior-blind
gradings at the measured sd after the grid; anchored gradings from the measured response to the gap,
scaled so they rise at the population rate (27 % up, +2.0 per grading, against 27.4 % and +2.15
measured); a real concept's reading cadence resampled; real first levels shrunk by the noise.

`mastery-known-truth.test.ts` (fixed seeds) holds the **permanent null test**: no learning, the
ratcheting grader, taught concepts read twice as often after the start, blind probes in both arms.
At k = 2 and 3 over 100 learners, every "you improved" verdict (aggregate rose, BH upward flags, the
toast/strip gain per eligible measurement, the probe headline) fires at most about 5 %, while the live
scores rise more than +10 on average. It also checks lane recovery (none 0, slow 1, medium 2.5, fast
5 points a week): rank order, slope, interval coverage, bias, power and gain sensitivity.

**Velocity at the bound (review N4).** The velocity estimand is the slope of the TRUE level at the
measured times (`trueMeanSlope`), not the planted rate: a concept near 100 stops rising, and no
estimator can recover a rise that did not happen. The lanes' slope intervals cover it (60 learners a
lane at k = 2: 92–97 %, bias ≤ 0.03 points a week). With `reachBound` the starting levels leave no
room for the rise; on the measured starting levels about 4 % of a fast learner's concepts then touch
100 and the interval still covers the bent slope (96.7 %); the test asserts both.

**The study's numbers** (`scripts/mastery-known-truth-report.ts`, 200 fixed-seed learners per lane and
k, all of k = 1, 2, 3 in `data/mastery-known-truth-report.json`). In lane none, "told rose", "gains /
eligible" and "probe says taught higher" are false-positive rates; elsewhere "told rose" is power. No
teaching effect is planted, so the probe column is a false-positive rate in every lane.

| k | lane | change coverage | change bias | velocity coverage | mean velocity | told "rose" | gains / eligible | true +20 announced | probe says taught higher | live scores' change |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | none | – | – | – | – | 0.0 % | – | – | – | +13.5 |
| 1 | slow | – | – | – | – | 0.0 % | – | – | – | +14.9 |
| 1 | medium | – | – | – | – | 0.0 % | – | – | – | +17.4 |
| 1 | fast | – | – | – | – | 0.0 % | – | – | – | +22.4 |
| 3 | none | 96.5 % | -0.02 | 94.0 % | +0.00 | 1.5 % | 3.4 % | – | 2.5 % | +13.5 |
| 3 | slow | 97.0 % | -0.01 | 91.5 % | +1.00 | 100.0 % | 9.8 % | – | 1.7 % | +14.9 |
| 3 | medium | 99.5 % | +0.02 | 93.5 % | +2.50 | 100.0 % | 30.4 % | 100.0 % | 3.3 % | +17.4 |
| 3 | fast | 100.0 % | -0.03 | 96.5 % | +5.01 | 100.0 % | 50.9 % | 99.5 % | 0.8 % | +22.4 |

- **k = 1 gives no verdict in any lane**: only first gradings are prior-blind, so no concept is
  measured prior-blind twice. The live scores still rise about +13.5 points with no learning at all.
- **Rank order**: at k = 2 and 3 a learner of each faster lane shows a higher velocity than one of
  the next slower lane in 100 % of pairs.
- **Velocity coverage**, rechecked on 1,000 learners per lane: 94.6–96.1 % at k = 2 and 3 (the
  91.5 % above for slow at k = 3 is sampling noise at n = 200). Change coverage runs above 95 %
  (to 100 %) in the faster lanes: conservative.
- `mastery-known-truth-seed.integration.test.ts` holds the server's SQL to the simulator: a learner
  written as rows reads back with identical measurements, change statistics and probe holdout.

**The four lanes on the page** (`apps/web/e2e/mastery-lanes.e2e.ts`, run by hand with a test database
URL): the four learners at k = 3 are written as rows in one rolled-back transaction, read by the
server's statistics and output shaping, and served to this checkout's web app. Every line equals the
render of the server's figures; each change and velocity interval covers the truth; lane none is
"not distinguishable from no change" and the others "readings rose"; velocities rank none < slow <
medium < fast; the probe headline gives no verdict. Run 2026-11-11: all checks pass (velocities −0.05,
0.95, 2.52, 4.95 points a week).

## Computation

Compute-on-read, no cached state: the two RPCs read the view and the noise groups per request (timings
in the status file). Both are admin session or device key, like the other mastery RPCs.

## Verification of the generated wiring

Registration of the two RPCs and the three replicate steps in both workflows was checked against the
framework runtime's generated metadata; the exact commands are in
`docs/superpowers/plans/2026-11-11-mastery-statistics.md`.

# Mastery change statistics

Status and live numbers: [mastery-notifications-status.md](mastery-notifications-status.md), section "Mastery change statistics".
Code: `packages/core/src/lib/learning/mastery-change-statistics.ts` (pure, unit-tested), `grader-noise.ts`,
`mastery-change.ts` (reads), `packages/server/src/functions/learning/mastery-statistics.function.ts` (RPCs),
migration `0022_mastery_statistics.sql`.

The question this answers: **is the learner's mastery going up, down, or not detectably anywhere,
and does teaching a concept move it more than not teaching it?** The existing feed answers a
different question ("tell me about gains") and is positive-only by design; these numbers are signed,
include declines, and always carry an interval.

## Inputs

A **counted reading** is a row of `learning_mastery_readings` that is independent (one per origin;
`unchanged` copies dropped, as in the feed), at medium or high confidence, with a percent. Readings
are ordered by **`evidence_at`** (when the learner said it, migration 0018), never by grading time:
a backlog graded today says nothing about today.

## A. Grader noise

Every reading is one grading by an LLM, and regrading the same evidence gives a different number.
That spread is the measurement error of every figure below, so it is measured, not assumed.

- **Estimator.** Pooled within-group sd, `sqrt(Σ(n_i−1)s_i² / Σ(n_i−1))`, over groups of completed
  gradings that share concept, evidence ids and prompt revision, of the **live model only**
  (`LIVE_GRADER_MODEL`, today `codex/gpt-5.6-luna/xhigh`), plus every stored replicate spread
  (`(replicates−1)·sd²`). The run digest carries `model` (0022) so this is an index read (0.2 s
  against 2 s through the snapshot).
- **Why pooled, not the mean of per-group sds.** The earlier audit's 8.6 points averaged per-pair
  sds; a pair's sd is biased low (E[s] ≈ 0.80σ for n = 2). The pooled estimator is unbiased for σ².
  Measured on dev (2026-11-11): **11.75 points** over 1,253 df (all live-model groups); counted-only
  groups 12.05 (df 542); all models 11.77 (df 1,825). Below 30 df the fallback 11.75 is used and
  reported as `graderNoiseSource: 'fallback'`.
- **Assumption.** Noise is homoscedastic and independent between gradings. It is not exactly: the
  scale is bounded (0–100) and gridded (steps of 5), so near the bounds the error shrinks and is
  skewed. Concepts with a reading at 0 or 100 are counted (`atBound`, `nAtBound`) so a reader can see
  how much of the change sits where the error model is weakest. The 5-point grid adds a rounding
  variance of 25/12 ≈ 2.1 pt², already inside the measured sd.

## A. Per-concept change

- `from` / `to`: the first and last counted reading (by evidence time). With `sinceDays`, `from` is the
  last reading **before** the window (the state the window started from) and the concept needs a
  reading inside it.
- `delta = to − from`, with `se = sd·√(1/k_from + 1/k_to)` where `k` is the number of replicate
  gradings averaged into each reading (1 today). `beyondNoise = |delta| > 1.96·se`.
- `slopePerWeek`: weighted least squares of percent on evidence time in weeks, weights = replicates,
  `se = sd/√Sxx`. Unequal reading counts and spans are handled by the weights and Sxx: a concept with
  two readings a day apart has a huge se and barely moves the pooled slope.

## A. Aggregate

- **Mean change and mean slope**: DerSimonian–Laird random-effects mean over concepts, each weighted
  `1/(v_i + τ²)` with `v_i` its known noise variance. Random effects, because concepts truly differ
  (τ is reported as `betweenConceptSd`); a fixed-effect mean would claim precision it does not have.
- **95 % interval**: percentile bootstrap **over concepts** (2,000 resamples, fixed seed, so the
  same data always gives the same line). It reflects both the grader noise and the between-concept
  spread and needs no normality. No interval below 5 concepts.
- **`conclusive`** = the change interval excludes zero. The web line says "not yet distinguishable
  from no change" otherwise.
- **Limits.** Concepts are not a random sample of what the learner knows: they are the ones the
  learner kept talking about, which favours concepts in active use. Regression to the mean pulls a
  concept first read low upward with no learning at all; the mean change is therefore an upper
  bound on learning, and only the holdout (C) separates teaching from that drift.

## A. Noise-aware gain notifications

The feed's gain rule was `gain ≥ GAIN_MIN_POINTS` (+10). With σ ≈ 11.75, the difference of two
single gradings has sd σ√2 ≈ 16.6, so +10 is well inside noise. The rule is now

    threshold = max(GAIN_MIN_POINTS, 1.645 · σ · √(1/k_now + 1/k_prev))

one-sided 95 %, with `k_prev` conservatively the fewest replicates among the earlier counted
readings. Today (k = 1) that is ≈ 27.3, i.e. +30 on the grid. Replicated readings (B) lower it
(k = 3 on both sides: ≈ 15.8). The +10 floor stays. The same rule drives the progress strip's ▲ up.

## A. Notifications vs statistics

A toast says "you improved just now"; the statistics say what happened, whenever it was graded.
They use the same readings under different rules (review findings 2–4, 10):

| | Toast (feed) | Statistics, strip, holdout |
|---|---|---|
| Unit | one reading, in the order readings went live | a **measurement**: gradings of a concept dated at the same time, averaged (weighted by replicates); a regrade is a replicate, never a gain |
| Uncited reading | sets a level (`previous_best`), never toasted, never moves the frontier | counts, dated by the 75th percentile of its learner messages |
| Must cite | a **learner** message (agent text does not count) | — |
| Newness | that message strictly newer than every cited learner message already shown | — |
| Recency | that message at most 7 days old when the reading goes live (`TOAST_RECENCY_DAYS`) | — (backfill lands in its evidence week) |
| Size | ≥ max(+10, 1.645·σ·√(1/k+1/k')) over the best counted reading already live | the strip's ▲ up uses the same threshold over the best measurement on older evidence, cited measurements only |

**Dating uncited readings.** 40 % of counted readings cite nothing and used to be dated by the newest
learner message in their evidence set. Measured on dev's 260 cited readings, that message is on
average 6.9 days later than what the reading actually cites (median error 1.3 days); the 75th
percentile of the learner messages is −0.3 days (median error 0.6 days). So an uncited reading is
dated at that percentile. It enters the change statistic as a level; it never establishes a toast.

On dev (2026-11-11) none of the 20 labelled gains (0 real, 12 noise, 5 backfill, 2 wrong, 1 unsure)
survives the final rule, and of the 38 historical +10 gains none survives; one first clear remains.

## B. Replicate grading

Policy setting `gradingReplicates` (1–5, default 1). k = 1 writes exactly what it wrote before (readings,
receipts and the assessment cache are byte-identical; tested); the only difference is one recorded
no-op plan step in each workflow's history.

With k > 1, after the primary grading (manual: the run; reactive pass: the last assessed part,
which is the part that becomes the reading) the workflow runs k − 1 replicate steps, each its own
durable step with its own receipt in `learning_concept_assessment_replicates`. A step reserves its
row before calling the model; a replay finds the receipt and does not call again, and a reservation
without a receipt (the process died mid-call) is recorded `uncertain`, never retried, so nothing is
paid twice. A plan row hides the reading from the view until the combine step writes the summary:

- reading = **raw mean** of the numeric gradings (not rounded); the grid value is display only;
- spread stored (sd, min, max); tokens and duration summed;
- confidence = the **weakest** replicate's (a reading is no more certain than its least certain
  grading).

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

- **Units.** Per concept: baseline = last counted reading with evidence before the phase start, else
  the first after; follow-up = the latest counted reading after the baseline and after the start.
- **Effect: ANCOVA**, OLS of follow-up on [1, baseline, taught]; the taught coefficient. Chosen over
  the change score because assignment is randomized: ANCOVA is unbiased then even with a noisy
  baseline, and its variance is never above the change score's (a simulation test checks both). The
  interval is a stratified bootstrap (resampling within each arm).
- **Minimum.** No estimate until 20 concepts per arm are measured twice: the line says
  "setting baseline: X of 20 held-out concepts measured twice".
- **Power.** `MDE = (1.96 + 0.84)·s·√(1/n_t + 1/n_h)` at 80 % power, two-sided α 0.05, with `s` the
  ANCOVA residual sd; before the arms can be fitted, the residual of follow-up on baseline over every
  concept measured twice. Concepts needed to detect 5 points: `n = (1.96+0.84)²·s² / (5²·p(1−p))`.
- **Probes** ([blind-probes.md](blind-probes.md), migration 0023). A reading is a probe answer when its
  `evidence_at` falls within 24 h after a live turn whose guidance probed that concept
  (`learning_live_feedback_turns.probe_concept_id`). Probes reach both arms with equal probability, so
  the same ANCOVA over probe answers only (`probe`) compares the arms on an equal opportunity to show
  evidence. `probe` is null while no reading is a probe answer (the `blindProbes` switch is off today).
- **Limit.** Held-out concepts are still talked about by the learner, only not taught, so the effect
  is "teaching on top of exposure". Readings are opportunistic: a taught concept is more likely to be
  read again, which the probe estimate exists to check.

## Computation

Compute-on-read, no cached state: the two RPCs read the view and the noise groups per request (timings
in the status file). Both are admin session or device key, like the other mastery RPCs.

## Verification of the generated wiring

Registration of the two RPCs and the three replicate steps in both workflows was checked against the
framework runtime's generated metadata; the exact commands are in
`docs/superpowers/plans/2026-11-11-mastery-statistics.md`.

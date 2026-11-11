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
- **The reading's own error σ_e (review round 2, NB1).** The k gradings of one reading all grade the
  same evidence, so they share whatever that evidence misstates about the learner (a good or bad day,
  a thin or rich run). Regrades of identical evidence measure σ_g only. A measurement is therefore
  `truth + e + mean of k grader errors`, with `Var = σ_e² + σ_g²/k_eff` (`measurementVariance`), and
  every rule below uses that variance: the per-concept se, the random-effects variances, the slope
  weights, the gain rule (SQL `BLIND_GAIN` and `isBlindGain`).
  - **Estimate** (`evidenceNoise`, review round 3, S1/S2): consecutive prior-blind measurements of a
    concept, both of a single run, taken in disjoint pairs, **by read-rate stratum**. A concept whose
    median gap between blind measurements is ≤ 7 days is *often read* and pairs ≤ 7 days apart; the
    rest are *rarely read* and pair ≤ 28 days apart, with the stratum's change per day of gap removed
    (one df), because those gaps carry learning. σ_e used is the **larger** stratum value: a pooled
    estimate from often-read concepts read σ_e ≈ 4 for a learner whose rarely-read concepts had 15,
    and flagged a false rise in 53 % of such null learners (now 1.5 %, tested). For a pair
    `E[d²] = 2σ_e² + σ_g²(1/k₁ + 1/k₂)`, so `σ_e² = mean(d²)/2 − σ_g²·mean(1/k₁+1/k₂)/2` (floored
    at 0), with a χ² interval (Wilson–Hilferty) on the pair count. Seven days of learning inflate it,
    which only widens intervals. Multi-run measurements are excluded: their replicates were graded at
    one time and would read as no evidence error.
  - **Small samples (review round 3, S1).** Per stratum: ≥ 30 pairs gives the point estimate
    (`measured`); 5–29 pairs give the **one-sided 80 % upper bound** (`upper_bound`); fewer, or an
    upper bound of 0, give the fallback **18**, the top of dev's 95 % interval (5.5–18.1), not below
    it. Replicate credit (k_eff > 1) needs **every** stratum `measured` with σ̂_e > 0: a σ̂_e of 0
    never earns it. At 10–15 pairs the old point estimate (from 10 pairs) let false gains run at
    4.7–6.7 % and any-up at up to 14 %; the bound keeps them at ≤ 1.3 % and ≤ 1 % for true σ_e 5,
    10 and 15 (`mastery-evidence-noise-null.test.ts`: t-tailed evidence error, a Poisson reading
    clock, the 5-point grid, none of which the estimator assumes). The simulation plants σ_e 10
    (`SIM_EVIDENCE_SD`), no longer tied to the fallback. The page reports each stratum's σ_e, how
    it was estimated, its pairs and whether credit is given.
  - **Measured (2026-11-11, read-only).** Dev: 13 pairs, **σ_e 9.9 (95 % 5.5–18.1)**, ρ = σ_e²/(σ_e²+σ_g²)
    ≈ 0.68; at ≤ 1 day 9 pairs, 8.9. learner_sim run `e54225af` (18 learners): 19 pairs, σ_e 5.5
    (2.1–10.1), σ_g 6.45; its sessions are compressed, so learning between pairs may be part of it.
    The study below brackets these at ρ = 0, 0.34 and 0.7.
- **Grid.** A single grading is on a 5-point grid (rounding variance 25/12, already inside the
  measured sd). Concepts with a measurement at 0 or 100 are counted (`atBound`).

**Consequence at the default policy (k = 1).** Only first gradings are prior-blind, so a concept is
never measured prior-blind twice and **no verdict is given**: the line says "No concept is measured
twice without the previous score yet". Verdicts need `gradingReplicates` ≥ 2 (cost in B). This is
the honest state, not a defect to hide: the old verdicts read the ratcheting series.

## A. Per-concept change (prior-blind)

- `from` / `to`: the first and last prior-blind measurement (by evidence time). With `sinceDays`,
  `from` is the last measurement **before** the window and the concept needs one inside it.
- `delta = to − from`, `se = √(Var(from) + Var(to))` with `Var = σ_e² + σ_g²/k_eff` (A), two-sided `pValue`.
- `beyondNoise`: **Benjamini–Hochberg** at FDR 0.05 across the concepts reported together (review S3);
  the unadjusted count and the count chance alone gives (5 % of the concepts) are reported beside it.
- `slopePerWeek`: weighted least squares on evidence weeks, weights `1/Var`, `se = 1/√Sxx` (weighted Sxx);
  none when the weeks do not vary.
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
- **Grader drift (review round 2, S-b).** If the prior-blind grader itself drifts with calendar time
  (a model update behind the same name, a change in what runs contain), every concept moves together
  and the aggregate says "rose" with no learning: +1 point a week fired 27 % of the time at k = 2
  over 60 null learners (tested). `blindDrift` estimates the drift as the pooled within-group slope of
  prior-blind grades of **identical evidence** (concept, evidence ids, prompt revision) on grading
  time, with a t interval. A verdict must clear it over the change's span: "rose" needs the interval's
  lower end above `max(0, driftHigh·span)`, "fell" its upper end below `min(0, driftLow·span)`
  (`clearsDrift`). An unmeasured drift (no regrades apart in time) **withholds** the verdict; the
  line says so (`withheldForDrift`) with what the interval did clear: "readings rose beyond grader
  noise but not beyond the grader's possible drift" (review round 3, N1). Dev today: 212 regrade groups but only 8 spread over more than
  a day, sxx 2.3 week², drift 4.2 a week (95 % −4.6 to 13.0), so dev's verdicts are withheld until
  the panel below exists. The probe holdout is immune (both arms drift alike).
- **Drift panel (built 2026-11-11; `grader-drift-panel.ts`, `learningDriftPanelWorkflow`, migration
  `grader_drift_panel`).** The drift every verdict above must clear now comes from this panel only
  (`graderNoise().blindDrift`); the ad-hoc regrade groups it read before are no longer used.
  - **Items.** P = 30 per learner (`selectLearningDriftPanel`, chosen once and stored in
    `learning_drift_panel_items`; a stored panel is never re-chosen, and with no candidate nothing is
    stored). A candidate is a reading with a prior-blind measurement by the live model whose frozen
    prompt is at the **live revision** and whose evidence reads back **byte-identically**: the panel's
    input rebuilt from the stored ingredients (concept, read-only context turns, new evidence, every
    field in jsonb order) equals `priorBlindPrompt(frozen prompt)`, the prompt its replicates were
    graded with. Dev 2026-11-11: 174 of 182; the rest carry a legacy concept version or an older
    section layout and are left out, not approximated. The **paid** regrade sends those raw stored
    objects (the schema only validates them) and checks at call time, against the immutable source
    run, that the data sections it sends hash to those of `priorBlindPrompt(source)` (the whole prompt,
    at the source's own revision); on a mismatch it records the item `failed`, receipt `refused`, and
    pays nothing (`panelInputMismatch`). *Correction (review round 1, B1):* the first build parsed the
    stored objects through the schema on the paid path, dropping `authorship`, `sourceVersion`,
    `sourceOrder`, `logicalKey` and `correlation.*` (about 45 % of the bytes); dev week 2026-11-09 was
    graded that way (8 of its 24 completed regrades came back `insufficient`, no score). The grader key
    carries `PANEL_INPUT_REVISION`, so that week stays in its own window and never pools with later ones.
  - **Who the panel represents (review round 1, S6).** One panel per learner who has one; today only
    the admin's own learner on dev (`selectLearningDriftPanel` uses the session's user). The drift is
    a property of the GRADER, so `graderNoise` applies the panels' pooled drift to every learner's
    verdicts: that is valid only as far as the panelled learners' evidence is like everyone else's.
    The levels are as balanced as the candidates allow, not equal: dev's 11/10/8/1/0 follows its
    candidates (122/44/8/1/0), so a drift confined to the top bands is barely sampled. Per-band drift
    is computed (`driftPanel.bands`); `bandsDisagree` is set when two measured bands' intervals do not
    overlap, i.e. the pooled drift hides a level effect. Regression to the mean is no bias here: the
    slope uses only regrades, centred within each item, never the source score.
  - **Stratification.** Five 20-point levels of the reading's prior-blind percent take turns, so every
    level gets an **equal** share until it runs out (not a proportional one: a drift that differs by
    level, a ceiling or a floor, shows only if every level is present); inside a level the concept
    used least so far wins, ties by a hash of (selection revision, learner, run id). The result depends
    on the candidate set and the seed only. Dev: levels 11/10/8/1/0, 28 concepts.
    *Deviation:* the proposal drew "from evidence older than the window and never shown again"; the
    panel draws from every eligible reading (the learner never sees a regrade at all, and a regrade's
    output goes nowhere but the panel table), because dev has too few old readings at the live revision.
  - **Weekly run.** `SCHEDULES: learning-drift-panel`, Mondays 04:00 UTC (and `runLearningDriftPanel`,
    admin, once per week). One workflow run per week; each item is its own durable step through
    `LearningConceptAssessmentService.gradePrepared` (the shipped call, validator and one repair
    retry) with the **current** live prompt and `ASSESSMENT_MODEL`, on the workflow queue the
    assessment steps use. A regrade is reserved before its paid call, so a replay finds either its
    outcome (returned as it is) or a reservation without one (recorded `uncertain`, never paid
    again; a result that still lands later replaces the stamp): idempotent per (item, week). An item
    that cannot be built or whose call throws is recorded `failed` and the week goes on; a failed or
    cancelled week run is started again by the next schedule tick or admin call, and regrades only
    what is pending. Policy `driftPanel` (default on) and `driftPanelCallCap` (default 60 gradings a
    run, counting the week's earlier ones; a grading is two calls only when the validator's repair
    retry fires; an `uncertain` row counts its started call). Under the cap learners take turns, one
    item each per round, in a weekly rotating order; within a learner items go in item order, and
    since selection numbers them level by level every prefix is itself stratified and a short share
    regrades the same items every week. The regressor is the week label, not the grading time: a run
    late in its week shifts x by up to 6 days (±3.5 days simulated: no measurable effect).
  - **Windows.** A window is one grader: live prompt revision + model (`learning_drift_panel_windows`,
    with the reason). A change starts a new window and only the current window's regrades count, so a
    revision change is a break, never drift (review round 3, S5); the panel itself measures the grader
    on FIXED evidence only, not a change in what runs contain.
  - **Estimate.** Groups = items, x = weeks since the window started, over the last W = 8 weekly runs.
    `panelDrift` = `blindDrift`'s pooled within-item slope, its interval **widened to also cover a
    week-clustered interval** (each week's mean item-centred residual regressed on the week, t on
    W − 2 df). *Deviation:* the proposal's interval assumed every regrade independent; all of a week's
    regrades share one grader state, and with a week shock of sd 2 the item-level interval covered
    the true drift 69 % of the time against 93 % for the widened one (tested). The price is width:
    ±0.47 a week at 30 × 8 (95 % coverage 95.5–97 % at drift 0, +0.25, +0.5, tested), not ±0.37.
    **Bound when weekly shocks persist (review round 1, S5).** With an AR(1) grader wander (ρ 0.7,
    sd 2) the interval covers the underlying linear rate only about 81 % of the time (ρ 0.9: 82 %;
    one-sided misses 9 %), and a Newey–West widening does not help at W = 8 (80.8 % with lag 1). What
    it does cover is the grader's **realised trend over the window** (99.2 %, ρ 0.9: 98.7 %, tested):
    a persistent wander is itself a trend over 8 weeks and no 8-week estimator can tell the two apart.
    So the drift rule bounds what the grader did over the last 8 runs, which is what moved the
    readings graded in that time; it is not a forecast, and a change line spanning a longer period
    than the window is covered only as far as the grader's recent trend represents it.
    What the generators assume and the estimator does not: Gaussian grader noise of the assumed sd,
    one linear rate shared by every item, and no clipping at 0 or 100 beyond `blindGrading`'s.
  - **Withheld until bounded, and when stale.** Below 4 weekly runs in the window the interval is
    null, so every aggregate "rose"/"fell" is withheld; `GraderNoiseComponents.driftPanel` carries the
    window, the weeks so far, and the week the 4th run (and the full 8) should land, for the page to
    say why and until when. When the latest run is more than 2 weeks old (panel switched off, runs
    failing) the drift is `stale` and withheld the same way (review round 1, S4): an old slope says
    nothing about the grader now.
  - **Never a reading.** Regrades live only in `learning_drift_panel_*`, outside every table readings,
    notifications, the holdout, GrowthBook's `learning_blind_measurements` and the stall alarm read;
    GrowthBook's role gets no grant. The workflow test compares all five before and after a real run
    on readings of the same learner. Evidence text stays in the database (ingredients, model receipt);
    step outputs carry ids, statuses and numbers.
- **What the drift rule covers (review round 3, S3, S5).** It is measured on **fixed evidence within
  one prompt revision**: the grader regrading the same messages. A prompt revision is a break it
  cannot see across, so the drift panel starts a new window at a revision change, and `masteryChanges` counts the prompt
  revisions among the blind measurements each change reads (from its anchor, concepts with two or
  more readings). With more than one, the change and velocity lines give **no verdict** and say the
  prompt changed (`withheldForRevision`). The rule covers the **change line and velocity**: velocity
  needs its slope interval to exclude 0 and clear the drift interval per week (`slopeConclusive`),
  else the line says "not beyond the grader's possible drift" and prints the drift beside it. Since
  round 4 (strip review B1) it also covers the **per-concept gain** behind the strip's ▲ and gain
  notifications (`blindGain`, A): a rise beyond noise that the drift could produce is
  `withheldForDrift`, never a gain. It does **not** cover the Progress page's per-concept flags
  (`conceptChanges`), which test grader noise only and say so ("these flags test grader noise only").
- **Units of velocity (review round 3).** Velocity is in prior-blind grader points per week. On
  simulated learners with an exam as ground truth (learner_sim run `e54225af`) prior-blind readings
  sat about 30 points above the exam and moved about 0.46 points per exam point, so the line says it
  is not in points of exam-measured knowledge.
- **Drift panel (proposal, not built).** Each week, regrade a fixed panel of P past evidence sets
  prior-blind at the current prompt revision; drift = the pooled within-item slope over a rolling
  W-week window. Its interval half-width is `t·σ_g/√(P·Σ(w−w̄)²)`: 30 items × 8 weeks gives
  ±0.37 a week, 60 × 8 ±0.26. Cost: P last-part gradings a week (30 × 46k input / 0.93k output
  tokens ≈ 1.4M input tokens and 5 minutes of model time a week on the subscription). A prompt or
  model change restarts the window. Items are drawn once, stratified by level, from evidence older
  than the window and never shown to the learner again. Power with the rule and such a panel (no true
  drift, 100 learners each) is in the study section.
- **Limits.** Concepts are the ones the learner kept talking about, not a random sample; regression to
  the mean pulls a concept first read low upward. Only the holdout's probe estimate (C) separates
  teaching from that.

## A. Gain rule (toast and strip)

A gain is a counted prior-blind measurement above the gradings-weighted **mean** of the concept's
earlier counted prior-blind measurements (review S11: the maximum made a gain harder to announce the
more often a concept was read) by

    max(GAIN_MIN_POINTS, 1.645 · √(Var_now + Σ k_i²·Var_i / K²) + 2.5 / lcm(k_now, K))

with `Var_i = σ_e² + σ_g²/k_eff,i` (A) and K = Σ k_i: one-sided 95 % on the difference, where each
earlier measurement brings its own evidence error, so averaging earlier readings shrinks σ_e and
averaging gradings of one reading does not. k_eff uses the measurement's runs (review round 2, S-c:
a measurement merged from several runs is not k independent gradings); without measured σ_e it is 1.
At the dev σ_e 9.9 and k = 2 everywhere, one measurement must rise about +27 over one earlier
(+18 at k = 1 under the old grader-only rule). The last term is the
continuity correction for the grid: a mean of k gridded gradings moves in steps of 5/k, so without it
k_now 1 against k_before 4 fires 5.8 % of the time under no change (the threshold 12.4 sits just
below the reachable 12.5); with it every combination of k_now ≤ 3, k_before ≤ 10 fires ≤ 5 % (tested).
The +10 floor is a product rule and takes no correction. SQL `BLIND_GAIN` (a window over the
earlier measurements' Σk, Σk² Var-terms) and pure `isBlindGain` are twins (tested on 400 cases each
over five noise settings, including σ_e = 0 and no replicate credit). A live (anchored) rise is never
a gain. The page's noise line states σ_e and the threshold at the learner's median k (review N-b),
not a one-grading figure, quoted as "about" (review round 3, N4: measurements of other k face a
somewhat different bar).

**Drift (round 4, strip review B1; review round 3 S3).** Beyond noise is not yet a gain. `blindGain`
(pure) and SQL `BLIND_GAIN` (twins, with `BLIND_BEYOND_NOISE` and `BLIND_WITHHELD_FOR_DRIFT`) also
require the rise's one-sided noise lower bound to clear the drift the way an aggregate verdict does
(`clearsDrift`):

    rise − (1.645 · √(…) + 2.5 / lcm(k_now, K)) > max(0, d_low · gap, d_high · gap)

where [d_low, d_high] is the weekly drift panel's 95 % interval (points per week, `graderNoise.blindDrift`)
and gap is the weeks from the k-weighted mean evidence time of the earlier measurements to now, the
evidence-time span the aggregate rule uses, so a linear drift d moves the compared difference by
exactly d·gap. While the drift is unmeasured (the panel's first 4 weeks: null interval) no rise is a
gain: it is `withheldForDrift`. The strip reports those per window (`withheldForDrift`, concepts not
in `up`); the feed sends no gain notification for them. Tested: the strip review's repro (k 2,
40 → 70 over 4 weeks at dev noise) is withheld under dev's drift [−4.6, +13.0] and under unmeasured
drift, and a gain at [−0.4, +0.4]; with the grader drifting at the interval's high end and no
learning (uniform grading error, Laplace evidence error) the rule fires 4.3 % of 20,000 comparisons
where the noise rule alone fires 20.8 %; a planted +45 over 4 weeks at k 2 is a gain > 75 % of the
time at [−0.4, +0.4]; the SQL and the pure rule agree on 900 cases over five noise settings and six
drift intervals (null, zero, straddling, wholly positive, wholly negative). Postgres `GREATEST`
ignores NULLs, so the SQL refuses a null drift explicitly (the twin test caught it).

**The Osmosis Map strip (review round 3, B2).** Its before → now figures are the **live** grader's
scores, the ones the map shows (`scores: 'live'`), labelled in the Progress page's own phrases: "your
scores from the live grader (each grading starts from the previous score; the grader alone raises a
score about +2.1 points per grading), so they are not evidence of learning" (`liveRisePerGrading`,
the measured mean move of anchored gradings). Its ▲ counts **only** prior-blind gains beyond grader
noise and clear of the grader's drift (`up`; concepts beyond noise but not clear of the drift are
counted apart as `withheldForDrift`, worded by the strip); a window without one states the prior-blind finding ("no verdict yet" while no concept was
`compared`). A first clear reading is an event of the live grader, counted apart (`firstClear`, "N
first clear readings (live grader)") with no ▲, so an anchored first clear is never shown as a gain.
The strip's gain reads each measurement's runs (`scoped.blind_runs`, and `m.blind_runs` in
`EVIDENCE_HISTORY`), pinned by a two-run measurement in `mastery-change.integration.test.ts`.

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

**What raising k buys (for the owner).** Going from k = 1 to k = 2 buys the verdicts themselves: at
k = 1 no concept is measured prior-blind twice, so nothing can be said. Beyond that, extra gradings
only average away the grader's part of a reading's error, never the evidence's. At the dev
estimates (σ_g 6.74, σ_e 9.9) a measurement's variance is 143 at k = 1, 121 at k = 2, 113 at
k = 3, against a floor of 98 that no k crosses; the gain threshold moves from about 27 (k = 2) to
26 (k = 3). In the study at ρ = 0.7, a 1-point-a-week learner is told "rose" 78 % of the time at
k = 2 and 80 % at k = 3. So **k = 2 is where the money is; k = 3 adds about +26 % input tokens per
reading for a 5 % smaller variance.** σ_e's interval is wide (5.5–18.1): at its low end k = 3 still
cuts the variance only 14 % against k = 2. Reading a concept more often (more measurements) is what
shrinks σ_e's share, not grading one reading more.

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
  "taught concepts scored higher on probes beyond grader noise". Its population is the concepts
  with a delivered probe since the start, and its follow-up is the answer to each concept's **first
  delivered probe** (the probe analysis's `k = 1`: `probeAnswerEvidenceSql` with `firstSince`), not
  a later answer: being asked is practice, and until 829754b a held-out concept was probed about
  four times as often (blind-probes.md, round 5 B-1); the scheduler now probes both arms at the same
  per-concept rate, but a later answer still carries the earlier probes' practice (a test with +3 per probe turns a +5 effect negative when the
  latest answer is used). A first probe whose answer produced no counted prior-blind reading is
  attrition in its arm (`baselineOnly`, shown on the page), never replaced by probe 2's answer:
  falling through gave −0.95 at 75 % of answers read and −2.3 at 50 % (review round 6, S-1; tested
  at q = 1, 0.75, 0.5).
  **Time to the answer (review round 2, NB2).** When a held-out concept is probed sooner (the
  scheduler before 829754b), its first answer comes fewer weeks after its baseline; with common learning that alone makes taught concepts
  score higher (red on the old code: mean effect > 2, firing beyond 5 %, at 0.25 against 1 probe a
  week, tested). The headline therefore adjusts for the weeks from baseline to follow-up, in
  **GrowthBook's form** (review round 3, S4): the pooled within-arm slope of change on weeks
  (`commonTimeSlope`) moves each follow-up to the mean weeks, then OLS on [1, baseline, taught], with
  the slope counted as a parameter (df = units − 4, residual variance rescaled to it). The server's
  estimate is therefore exactly the regression GrowthBook runs on `probe_percent_common_time`
  (tested equal to 1e-9; the slope itself is pinned by hand). The old joint fit put weeks in the
  regression beside a baseline measured with error, and the error-in-baseline slope leaked into the
  weeks coefficient: +0.27 bias under linear common learning of 2.5 a week (review: +0.65); the
  two-step form gives −0.14. Reported as "adjusted for baseline and weeks to the answer (taught X
  wk, held out Y wk)". Weeks are fixed by the probe schedule, not by the outcome.
  **Limit (review round 3, B1).** A linear time adjustment cannot remove bias when common learning
  is concave or when the learner's activity drives both probing and learning. Mean bias over 1,000
  simulated learners each, at the old scheduler's unequal probe rates (taught 0.25, held out 1 a week):

  | world | adjusted | naive (no time adjustment) |
  | --- | --- | --- |
  | concave common learning (10 pts, τ 1 wk) × activity-linked probing and learning (activity sd 0.6) | +2.51 | +3.18 |
  | concave (15 pts, τ 2 wk) | +1.14 | +2.70 |
  | activity drives probing only (concave 10, τ 1 wk) | +0.90 | +1.76 |
  | linear 2.5 / week | −0.14 | +2.17 |

  With **equal** per-concept probe rates in both arms the bias is ≤ 0.01 in every world, adjusted
  or not, because the arms' times to the answer no longer differ. The cause is therefore removed in
  the scheduler (equal per-concept probe rate in both arms, learner-measurement lane, 829754b), not
  in the estimator. `mastery-known-truth.test.ts` "B1" asserts |bias| < 0.5 at equal rates in all
  three worlds and > 1.5 at 0.25 against 1; a second B1 test reads the arm rates from today's
  scheduler (`probeCandidates`' uniform pick over 20,000 turns) and asserts the ratio is within 10 %
  of 1 and the bias at those rates under 0.5 (passing since 829754b). The time
  adjustment is **kept**: it costs nothing at equal rates (≈ 0 change) and halves the bias of the
  remaining linear part if the rates ever differ again. The page also shows the probed share per arm (probed /
  eligible), because the population conditions on being probed. The estimate over **all** prior-blind
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
- **GrowthBook** (migrations 0032, 0034, `mastery-holdout-growthbook.ts`). The experiment
  `exp_bkhj8zimvvaf8ar` analyses the headline estimand, not the live readings. Fact table
  `ftb_bkhj8zimwc6mqyc` (SQL from `holdoutProbeFactSql`) has, per concept with a pre-start baseline,
  its prior-blind answer to its first delivered probe and its last prior-blind measurement before the start.
  It reads `learning_blind_measurements(user, start)` (0034, with `first_probe`), a SECURITY DEFINER copy of MEASUREMENTS + the probe
  rule: GrowthBook's read-only role may run it but cannot read the tables carrying the learner's
  messages. Goal metric `fact__2CgwFsKckcfrdBssncU52i` is a ratio, sum(probe_percent) /
  sum(probe_answer). A plain mean would score an unprobed concept 0, and held-out concepts are
  probed more often. NB2 in GrowthBook: column `probe_percent_common_time` is the answer moved to a
  common follow-up time, `probe_percent − slope·(weeks − mean weeks)`, with the pooled within-arm
  slope of change on weeks (TS twin `commonTimeFollowUps`, tested equal); it is the goal metric's
  numerator. The fact table is keyed `concept_id` (review S-d).
  - **Live objects (2026-11-11, backups `20261111T152524Z-*` in `/var/lib/learner/growthbook-backups/`).**
    `ftb_bkhj8zimwc6mqyc`: `userIdTypes` `[]` → `["concept_id"]`, SQL → today's `holdoutProbeFactSql`,
    columns `probe_percent_common_time` added. Goal `fact__2CgwFsKckcfrdBssncU52i`: numerator
    `probe_percent` → `probe_percent_common_time`. New secondary `fact__2CgwNhHQLdbh6FEBigtGV8`
    (proportion: assigned concepts with a first-probe answer after exposure, per arm; the goal
    conditions on it).
  - **Trap: GrowthBook infers a fact table's columns from returned rows.** While the SQL returns no
    rows (dev today: no probe answered) every SQL save marks all columns `deleted` and drops the
    identifier type, which is why the goal metric had no query and the experiment no results. After
    any SQL edit, POST the columns (with `deleted: false`) and `userIdTypes` again and GET to check.
  - **Analysable, shown on seeded rows.** Snapshot `snp_2CgwNhfGyPixAm5Gyv2jzo` now runs the goal
    query (traffic 904 taught, 251 held out; sums 0, as no probe is answered). That generated SQL, run
    on a seeded known-truth learner in a rolled-back transaction on a test database, gives per-arm
    numerator, denominator, covariate and probed-share sums exactly equal to the server's fact rows
    inside the snapshot window. GrowthBook's stats engine itself was not run on those rows: its only
    datasource reads dev, and the REST API cannot add a datasource pointing at the test database. Regression adjustment with a 365-day lookback takes the baseline as covariate,
  which is GrowthBook's form of the ANCOVA. The two live-reading metrics are kept as secondary and
  are labelled descriptive. `mastery-holdout-growthbook.integration.test.ts` checks that the function
  equals `countedMeasurements().blind` and that the fact rows equal `probeHoldoutUnits`. A
  change to MEASUREMENTS or to the probe rule fails it, and needs a migration replacing the function.
  - **Decision rule (review round 3, N2).** The page's frequentist estimate (server ANCOVA with the
    t-bootstrap interval, 20 per arm minimum) is the decision rule; GrowthBook is a cross-check of
    the same regression. Its experiment was switched from the Bayesian engine to **frequentist**
    (2026-11-11, backup `20261111T164121Z-exp_bkhj8zimvvaf8ar.json`) so both read a p-value-style
    interval; they can still differ near the line (GrowthBook's delta-method ratio and CUPED vs
    the server's bootstrap over concepts), and then the page decides.
  - **`minSampleSize` (review round 3, N3).** GrowthBook's `hasEnoughData`
    (`packages/shared/dist/experiments/experiments.js` in the container) compares it with the
    metric's `value`, which for a ratio is the **numerator sum**, and takes the larger arm. With
    summed percentages, `20` passed on one answer of 20+. It is now **2000** (backup
    `20261111T164121Z-fact__2CgwFsKckcfrdBssncU52i.json`): each answer is at most 100, so at least 20
    answers in the larger arm. It still cannot require 20 in **each** arm; the page's minimum does.
  - **Single learner (review round 3, N3).** The fact SQL names one user
    (`learning_blind_measurements('<user>', start)`) and the assignment query lists every
    `learning_concepts` row, so the experiment's unit is "this learner's concept". That is correct
    while dev has one learner; a second learner would merge into the same units. Multi-learner
    analysis needs a `user_id|concept_id` identifier in both queries, and is not built.
- **Limit.** Held-out concepts are still talked about by the learner, only not taught, so the effect
  is "teaching on top of exposure". **Spill-over (review round 2, N-c):** assignment is per concept,
  and concepts of one `concept_group` are related; teaching a concept can raise its held-out
  siblings. That interference pulls the effect toward 0, so a null result does not mean teaching
  does nothing, and a positive one is conservative. Readings are opportunistic: a taught concept is more likely to be
  read again, which the probe estimate exists to check.

## Known-truth recovery and the permanent null test

`mastery-known-truth.ts` plants a learner's true trajectory and grades it with a simulated grader
calibrated on the live one (`data/mastery-grader-calibration.json`, numbers only): prior-blind
gradings at the measured sd after the grid; anchored gradings from the measured response to the gap,
scaled so they rise at the population rate (27 % up, +2.0 per grading, against 27.4 % and +2.15
measured); a real concept's reading cadence resampled; real first levels shrunk by the noise.
Review round 2, S-a: the generator no longer encodes the estimator's assumptions. Every grading of a
reading sees the same `truth + σ_e·N` (shared evidence error), a grader drift per week can be
planted, both arms are probed at 0.25 a week per concept (the scheduler since 829754b; the NB2 and
B1 tests set the old 1 against 0.25 on purpose), and the seeding
writes uncited readings (dated by the 75th percentile) and replicate summaries through
`combineReplicates`. The permanent null test asserts that the model which ignores σ_e fires far
beyond 5 % on that generator (mutation M19 is dead by construction).

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

**The study's numbers** (`scripts/mastery-known-truth-report.ts`, 200 fixed-seed learners per lane,
k and ρ, everything in `data/mastery-known-truth-report.json`; rerun 2026-11-11 at **equal** probe
rates, 0.25 a week per concept in both arms, as the scheduler since 829754b: review7 S1 found the
previous figures simulated 1 a week for held-out concepts). ρ is the share of a single grading's
variance that is evidence error: σ_e = 0, 4.9, 10.3 at σ_g 6.74; dev measures about 0.68. In lane
none, "told rose" and "gains / eligible" are false-positive rates; elsewhere "told rose" is power.
k = 1 gives no verdict at any ρ (rows omitted). No drift is planted and none is passed, so "told rose"
here is **before** the drift rule (power under it below).

| ρ | k | lane | change cov. | velocity cov. | mean velocity | told "rose" | gains / eligible | true +20 announced | σ_e estimated (cov.) |
|---|---|---|---|---|---|---|---|---|---|
| 0 | 2 | none | 92 % | 92.5 % | −0.01 | 4.5 % | 1.5 % | – | 2.1 (94.9 %) |
| 0 | 2 | slow | 96 % | 92.5 % | +0.97 | 99.5 % | 2.5 % | – | 2.1 |
| 0 | 3 | none | 95 % | 93.5 % | −0.00 | 3.5 % | 0.5 % | – | 1.6 (97.8 %) |
| 0 | 3 | slow | 97 % | 95.5 % | +0.99 | 100 % | 1.6 % | – | 1.5 |
| 0.34 | 2 | none | 92.5 % | 93 % | +0.00 | 4.5 % | 2 % | – | 5.8 (91.2 %) |
| 0.34 | 2 | slow | 95 % | 94.5 % | +1.00 | 94 % | 3.5 % | – | 5.5 |
| 0.34 | 3 | none | 95 % | 95.5 % | −0.01 | 3.5 % | 1.6 % | – | 5.5 (94 %) |
| 0.34 | 3 | slow | 97 % | 94.5 % | +1.00 | 99 % | 3.1 % | – | 5.4 |
| 0.7 | 2 | none | 95 % | 96.5 % | +0.02 | 3 % | 2.4 % | – | 11.1 (92.5 %) |
| 0.7 | 2 | slow | 95.5 % | 95 % | +1.00 | **68 %** | 3.5 % | – | 10.7 |
| 0.7 | 2 | medium | 95.5 % | 94.5 % | +2.49 | 100 % | 5.6 % | 0 of 3 | 11.1 |
| 0.7 | 2 | fast | 99 % | 93 % | +4.96 | 100 % | 13.1 % | **48.1 %** | 11.3 |
| 0.7 | 3 | none | 92 % | 94 % | −0.00 | 4.5 % | 2.2 % | – | 11.2 (91.2 %) |
| 0.7 | 3 | slow | 96 % | 94 % | +0.98 | **63 %** | 3 % | – | 11.4 |
| 0.7 | 3 | medium | 97.5 % | 94 % | +2.51 | 100 % | 5.8 % | 1 of 3 | 11.1 |
| 0.7 | 3 | fast | 99.5 % | 92 % | +4.98 | 100 % | 13.6 % | **52.1 %** | 11.1 |

**Power, restated (review round 2, S-e).** The previous table (σ_e = 0) claimed 100 % "rose" at one
point a week and 3.4 % false gains. With the evidence error modelled and estimated:
- False gains per eligible measurement stay at **0.5–2.4 %** in lane none at every ρ, because the
  gain rule carries σ_e (the reviewer's 19–24 % was the old rule on this generator; the test asserts
  the old rule fires > 20 % and the new one ≤ 6.5 %).
- "Rose" at one point a week falls to **68 % (k = 2) and 63 % (k = 3) at ρ = 0.7** (77 % and 85.5 %
  in the previous run, which probed held-out concepts 4× as often and so read more measurements),
  and a true +20 on one concept is announced 48–52 % of the time instead of 99 % (55–59 % before).
  At equal rates fewer close pairs reach a stratum, so σ_e more often rests on the 80 % upper bound
  or the fallback: with σ_e planted at 0 a true +20 is caught 66 % of the time from the estimated
  σ_e against > 80 % when σ_e is known (tested).
- **With the drift rule** (S-b) and a measured panel, slow-lane power drops further, because a
  small rise must also clear the drift's interval times its span. Since round 4 the same holds for
  the per-concept gain (A, Drift): the last two columns are the gain rule before → after its drift
  half. 100 learners per row, equal probe rates, no true drift (`scripts/mastery-drift-power.ts`):

  | ρ | k | lane | panel | drift ± | rose | rose under rule | withheld | gains / eligible | true +20 announced |
  |---|---|---|---|---|---|---|---|---|---|
  | 0 | 2 | none | 30 × 8 | 0.37 | 3 % | 0 % | 4 % | 1.6 % → 1.3 % | – → – |
  | 0 | 2 | none | 60 × 8 | 0.26 | 3 % | 0 % | 4 % | 1.6 % → 1.3 % | – → – |
  | 0 | 2 | slow | 30 × 8 | 0.37 | 100 % | 79 % | 21 % | 2.9 % → 2.3 % | – → – |
  | 0 | 2 | slow | 60 × 8 | 0.26 | 100 % | 87 % | 13 % | 2.9 % → 2.4 % | – → – |
  | 0 | 2 | fast | 30 × 8 | 0.37 | 100 % | 100 % | 0 % | 19.5 % → 18.2 % | 74.1 % → 70.4 % |
  | 0 | 2 | fast | 60 × 8 | 0.26 | 100 % | 100 % | 0 % | 19.5 % → 18.6 % | 74.1 % → 71.6 % |
  | 0 | 3 | none | 30 × 8 | 0.37 | 3 % | 0 % | 7 % | 0.5 % → 0.5 % | – → – |
  | 0 | 3 | none | 60 × 8 | 0.26 | 3 % | 0 % | 7 % | 0.5 % → 0.5 % | – → – |
  | 0 | 3 | slow | 30 × 8 | 0.37 | 100 % | 89 % | 11 % | 1.6 % → 1.1 % | – → – |
  | 0 | 3 | slow | 60 × 8 | 0.26 | 100 % | 97 % | 3 % | 1.6 % → 1.2 % | – → – |
  | 0 | 3 | fast | 30 × 8 | 0.37 | 100 % | 100 % | 0 % | 21.3 % → 20.2 % | 82.5 % → 80.1 % |
  | 0 | 3 | fast | 60 × 8 | 0.26 | 100 % | 100 % | 0 % | 21.3 % → 20.5 % | 82.5 % → 80.7 % |
  | 0.34 | 2 | none | 30 × 8 | 0.37 | 2 % | 0 % | 2 % | 2.2 % → 2.0 % | – → – |
  | 0.34 | 2 | none | 60 × 8 | 0.26 | 2 % | 0 % | 2 % | 2.2 % → 2.1 % | – → – |
  | 0.34 | 2 | slow | 30 × 8 | 0.37 | 95 % | 64 % | 31 % | 3.6 % → 3.1 % | – → – |
  | 0.34 | 2 | slow | 60 × 8 | 0.26 | 95 % | 80 % | 15 % | 3.6 % → 3.2 % | – → – |
  | 0.34 | 2 | fast | 30 × 8 | 0.37 | 100 % | 100 % | 0 % | 20.4 % → 18.9 % | 77.3 % → 72.1 % |
  | 0.34 | 2 | fast | 60 × 8 | 0.26 | 100 % | 100 % | 0 % | 20.4 % → 19.3 % | 77.3 % → 73.6 % |
  | 0.34 | 3 | none | 30 × 8 | 0.37 | 0 % | 0 % | 3 % | 1.4 % → 1.2 % | – → – |
  | 0.34 | 3 | none | 60 × 8 | 0.26 | 0 % | 0 % | 2 % | 1.4 % → 1.3 % | – → – |
  | 0.34 | 3 | slow | 30 × 8 | 0.37 | 99 % | 73 % | 26 % | 2.8 % → 2.2 % | – → – |
  | 0.34 | 3 | slow | 60 × 8 | 0.26 | 99 % | 83 % | 16 % | 2.8 % → 2.4 % | – → – |
  | 0.34 | 3 | fast | 30 × 8 | 0.37 | 100 % | 100 % | 0 % | 21.0 % → 19.5 % | 84.0 % → 78.7 % |
  | 0.34 | 3 | fast | 60 × 8 | 0.26 | 100 % | 100 % | 0 % | 21.0 % → 19.9 % | 84.0 % → 80.2 % |
  | 0.7 | 2 | none | 30 × 8 | 0.37 | 3 % | 0 % | 5 % | 2.4 % → 2.2 % | – → – |
  | 0.7 | 2 | none | 60 × 8 | 0.26 | 3 % | 1 % | 3 % | 2.4 % → 2.3 % | – → – |
  | 0.7 | 2 | slow | 30 × 8 | 0.37 | 70 % | 44 % | 26 % | 3.3 % → 3.0 % | – → – |
  | 0.7 | 2 | slow | 60 × 8 | 0.26 | 70 % | 48 % | 22 % | 3.3 % → 3.1 % | – → – |
  | 0.7 | 2 | fast | 30 × 8 | 0.37 | 100 % | 100 % | 0 % | 12.7 % → 11.6 % | 48.2 % → 43.2 % |
  | 0.7 | 2 | fast | 60 × 8 | 0.26 | 100 % | 100 % | 0 % | 12.7 % → 11.9 % | 48.2 % → 44.3 % |
  | 0.7 | 3 | none | 30 × 8 | 0.37 | 3 % | 1 % | 5 % | 2.3 % → 2.1 % | – → – |
  | 0.7 | 3 | none | 60 × 8 | 0.26 | 3 % | 2 % | 4 % | 2.3 % → 2.1 % | – → – |
  | 0.7 | 3 | slow | 30 × 8 | 0.37 | 78 % | 49 % | 29 % | 3.1 % → 2.7 % | – → – |
  | 0.7 | 3 | slow | 60 × 8 | 0.26 | 78 % | 59 % | 19 % | 3.1 % → 2.8 % | – → – |
  | 0.7 | 3 | fast | 30 × 8 | 0.37 | 100 % | 100 % | 0 % | 13.2 % → 12.1 % | 50.1 % → 45.2 % |
  | 0.7 | 3 | fast | 60 × 8 | 0.26 | 100 % | 100 % | 0 % | 13.2 % → 12.4 % | 50.1 % → 46.4 % |

  Medium and fast lanes are not withheld. At dev's ρ, a learner gaining a point a week is told so
  about half the time (44–59 %); the rest read "rose beyond grader noise but not beyond the grader's
  possible drift". The drift half costs the per-concept gain little once the panel is measured (a true
  +20: 48 → 43–44 % at ρ 0.7, k 2), and false gains stay at or below the noise rule's.
- σ_e is recovered without bias at ρ 0.34 and 0.7 (5.4–5.8 against 4.9, 10.7–11.4 against 10.3:
  the larger of two strata is a slight upward bias by design) and reads 1.5–2.1 when the planted value
  is 0 (a floor effect); the used stratum's 95 % interval covers the planted value 91–98 % of the time.

- **The probe headline gives no verdict for a learner of this size** (0 of 200 learners in every
  lane reaches the 20-per-arm minimum). Only the answer to each concept's FIRST probe counts (review
  round 6, S-1), and about 64 % of graded answers are low confidence, so of 159 concepts about 22
  held-out ones are probed and **7.8** get a follow-up (31.5 taught), against 20 needed; at the old
  4× held-out rate it was 11.8. At this answer rate a learner needs about 2.6 times as many concepts
  (≈ 400) for the held-out arm to reach 20. Before the first-probe fix the headline fell through to
  later probes' answers and reached the minimum, biased (−2.3 points at half the answers read, truth
  +5). The time covariate stays in place (NB2). Its
  false-positive rate is tested at 600 concepts instead (`mastery-known-truth.test.ts`).
- **k = 1 gives no verdict in any lane**: only first gradings are prior-blind, so no concept is
  measured prior-blind twice. The live scores still rise about +13.5 points with no learning at all.
- **Rank order**: at k = 2 and 3 a learner of each faster lane shows a higher velocity than one of
  the next slower lane in 100 % of pairs (98.8–99.4 % for none against slow at ρ = 0.7).
- **Velocity coverage** is 92–96.5 % in every row above (200 learners: ±3 points of sampling noise).
  Change coverage is 92–99.5 %; the null-lane rows at 92 % are within sampling noise of 95 %.
- `mastery-known-truth-seed.integration.test.ts` holds the server's SQL to the simulator: a learner
  written as rows reads back with identical measurements, change statistics and probe holdout.

**The four lanes on the page** (`apps/web/e2e/mastery-lanes.e2e.ts`, run by hand with a test database
URL): the four learners at k = 3 are written as rows in one rolled-back transaction, read by the
server's statistics and output shaping, and served to this checkout's web app. Every line equals the
render of the server's figures; each change and velocity interval covers the truth; lane none is
"not distinguishable from no change" and the others "readings rose"; velocities rank none < slow <
medium < fast; the probe headline gives no verdict. The noise fixture carries a measured 30 × 8
drift panel (±0.37 a week, S-b). Rerun 2026-11-11 with the shared evidence error (σ_e estimated
9.3–10.6 from 82 pairs): all checks pass (velocities −0.20, 0.94, 2.53, 5.13 points a week).

## Computation

Compute-on-read, no cached state: the two RPCs read the view and the noise groups per request (timings
in the status file). Both are admin session or device key, like the other mastery RPCs.

## Verification of the generated wiring

Registration of the two RPCs and the three replicate steps in both workflows was checked against the
framework runtime's generated metadata; the exact commands are in
`docs/superpowers/plans/2026-11-11-mastery-statistics.md`.

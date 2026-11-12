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
  weights, the gain rule (SQL `BLIND_GAIN` and `blindGain`).
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
- `beyondDrift` (review 4, S4): Benjamini–Hochberg at the same FDR on `driftPValue`, the two-sided
  p-value of `delta` against the band the grader's drift could produce over the concept's own span,
  `[min(0, low·span), max(0, high·span)]` from the drift's 95 % interval (1 inside the band; with a
  zero drift it is `pValue`). False while the drift is unmeasured and when the readings span more than
  one prompt revision; null where no drift rule applies (the live series). The aggregate counts it as
  `nBeyondDrift`, and the concepts line says how many flags clear the drift, or why none can.
  Tested on a generator whose grader drifts +4/week at the top of the interval with no learning, with
  uniform grader and Laplace evidence errors: about 4.4 of 40 concepts are beyond noise per run and
  0.11 beyond the drift; a run flags any in 9.5 % of runs (3.8 % with the errors made normal). The
  heavier tail roughly doubles BH's false-flag rate at its far end, for `beyondNoise` too: the normal
  p-value is the weak point, not the drift band.
- `slopePerWeek`: weighted least squares on evidence weeks, weights `1/Var`, `se = 1/√Sxx` (weighted Sxx);
  none when the weeks do not vary.
- `gradingsBetween`: live gradings of the concept between the two measurements (the opportunity count).

## A. Aggregate

- **Mean change and mean slope**: DerSimonian–Laird random-effects mean over concepts.
- **95 % interval**: `estimate ± t₀.₉₇₅(n−1) · se_boot · √(n/(n−1))`, se_boot from 2,000 bootstrap
  resamples over concepts (fixed seed). The percentile bootstrap undercovered at small n (review N2);
  the t-widened interval covers a true zero 92–98 % of the time at n = 20 (tested). **No interval
  below 20 concepts** (review S2): the line says "not enough data for an interval (20 concepts needed)".
- **A sitting-shared evidence error (review 4, S1; review 5, S1).** The bootstrap resamples concepts as
  if their errors were independent. A blind grading reads a session's messages, so concepts read in one
  sitting can share part of their error, and a shared error does not average out: with session sd 8 the
  concept bootstrap covered a true 0 in 75 % (60 concepts) and 62 % (120) of learners in the reviewer's runs.
  `sessionError` estimates its variance σ_u² from the residuals (each concept's mean and one pooled
  within-concept slope on evidence time removed, so common linear learning is not read as error) of
  readings of DIFFERENT concepts in one **sitting** (evidence times chained less than 30 minutes apart):
  E[e·e′] = σ_u²·K with K the two residuals' shared sitting loadings, σ̂_u² = Σe·e′ / ΣK, clamped at 0.
  It is **applied** over the same sittings (review 6, B1). Each interval's
  half-width becomes `√(half² + t² · extra)`, extra = σ_u² [Σ_d (Σ_i w_i c_id)² − Σ_i Σ_d (w_i c_id)²] / (Σw)²
  at the random-effects weights, with c_i the concept's sitting loadings (±1 on its change's two ends;
  the least-squares coefficients for its slope). Why sittings for both: until review 5 both were the
  UTC day, and two sittings on one day need not share an error, so their pairs pulled σ̂_u down (6.0
  for a true 8). Review 5 then applied the estimate over UTC days joined when a sitting ran past
  midnight; review 6 (B1) showed that join chains a learner whose daily sitting crosses midnight UTC
  (every evening from 7 pm Eastern) into one unit, where a change's +1 and −1 loadings cancel and
  nothing is widened (coverage of a true 0 fell to 53.5 % change / 43.0 % velocity at 200 concepts). A
  sitting that crosses midnight is one sitting; consecutive days never chain. A sitting split by the
  30-minute gap only loses pairs and splits a unit, so the gap errs short (60 and 90 minutes gave the
  same coverage below). The aggregate reports `session` (sd, pairs, sd added) and the noise line names
  it as an estimate. Coverage of a true 0 on the reviewer's independent generator (review 6's
  `sess.ts`; Poisson sessions 4 a week at random hours, or one sitting a day starting 23:24–23:54 UTC
  and lasting 45–75 minutes, session sd 8, log-normal read rates, k = 2 on the grid, σ_e estimated,
  300 learners each, recomputed at this commit):

  | world | change, plain → widened | velocity, plain → widened |
  |---|---|---|
  | 60 concepts, Poisson | 77.0 → 92.3 % | 60.0 → 92.3 % |
  | 120 concepts, Poisson | 62.7 → 91.7 % | 44.0 → 91.3 % |
  | 60 / 120, Poisson sessions straddling midnight UTC | 73.0 / 63.0 → 91.7 / 92.7 % | 63.0 / 47.7 → 94.0 / 93.7 % |
  | 60 / 120 / 200, a daily sitting across midnight UTC | 77.0 / 60.7 / 51.3 → 95.3 / 94.3 / 94.3 % | 63.7 / 46.7 / 40.3 → 95.7 / 93.7 / 92.3 % |
  | 120, a daily sitting at 18:00 UTC (control) | 60.7 → 94.3 % | 46.7 → 93.7 % |
  | 60, no shared error | 97.7 → 98.0 % | 95.3 → 95.3 % |
  | 60, a weekly shared error of sd 4 (not modelled) | 74.7 → 79.7 % | 55.7 → 70.3 % |

  The daily midnight learner now matches the 18:00 control exactly (the chained version gave 53.5 /
  43.0 % at 200 concepts). The Poisson rows sit 2–3 points under nominal: review 5's day clusters
  over-widened them (94.7 %), and with the unit the error is actually shared over, the estimate's own
  bias shows (σ̂_u averages 7.3–7.4 for a true 8 there, 6.2–6.3 when the Poisson sessions straddle
  midnight). Not corrected: a bias-corrected σ̂_u is the next step if the Poisson world is
  judged the realistic one. **An error shared across sittings is not covered** (the last row). The
  repository's own coverage tests (sessions at random quarter-days, sds of 0.6σ or 1.3σ, Laplace
  evidence and uniform grader errors; and a daily sitting from 23:40 UTC over 40 minutes) hold the
  widened coverage above 92 % (91 % for the daily one, measured 94 / 94 % change and 95 / 93 % velocity
  over 300 runs at 60 / 120 concepts) at 60 and 120 concepts.
  Dev today (read-only, one learner, 19 concepts measured twice): σ̂_u 7.6 from 42
  same-sitting pairs of different concepts (7.8 from 162 same-day pairs under the review-4 estimator);
  with so few concepts that cannot be told apart from common learning, and no interval is given there yet.
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
    run, that the data sections it sends equal, byte for byte, those of `priorBlindPrompt(source)` (the whole prompt,
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
  - **Weekly run.** `SCHEDULES: learning-drift-panel`, a daily 04:00 UTC tick whose Monday tick starts the week's run (and `runLearningDriftPanel`,
    admin, once per week). One workflow run per week; each item is its own durable step through
    `LearningConceptAssessmentService.gradePrepared` (the shipped call, validator and one repair
    retry) with the **current** live prompt and `ASSESSMENT_MODEL`, on the workflow queue the
    assessment steps use. A regrade is reserved before its paid call, and the call runs under the shared
    attempt lease (docs/operations/restart-safety.md): a replay waits for a live owner, adopts a dead
    owner's finished result, or runs the call again when the backend's repeat is free (codex, a local
    child); only a metered backend, or a key taken over 3 times, records `uncertain`. Idempotent per
    (item, week). The step retries 3 times, so a call lost with no result is taken over by the retry.
    An item that cannot be built or whose grading fails is recorded `failed` and the week goes on. A
    failed or cancelled week run is started again by the next daily tick or admin call within that
    week; it plans every item with no final outcome (no row, a bare reservation, or `uncertain`),
    those already started first. An item still without an outcome when its week ends stays so: that
    item misses one week, no person acts. The page counts the open week's regrades reserved over a day ago with no
    outcome ("a restart did not heal"). Policy `driftPanel` (default on) and `driftPanelCallCap`
    (default 60 gradings a run, counting the week's finished ones; a grading is two calls only when the
    validator's repair retry fires). Under the cap learners take turns, one
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
  `withheldForDrift`, never a gain. Since round 5 (review 4, S4) it covers the Progress page's
  per-concept flags too (`beyondDrift`, A).
- **Which clock (review 5, S3).** The panel measures drift per week of **grading** time, while every
  span above is in evidence time, and the grader works through a backlog (on dev the grading gap of
  consecutive measurements exceeds the evidence gap by more than three weeks for 18 % of pairs). So
  each rule takes the drift band over **both** clocks, `driftBand(interval, [evidence span, grading
  span])` = [min d·s, max d·s] over both interval ends and both spans: the flags (`driftPValue`), the
  gain (`blindGain`, SQL `BLIND_CLEARS_DRIFT`, which sums Σk·t over `completed_at` beside the evidence
  times) and the aggregate change (the concepts' mean span on each clock; the line quotes the longer).
  A measurement's grading time is its runs' gradings-weighted mean time its blind gradings existed
  (`graded_at`): the live run's `completed_at`, or its replicates' `combined_at` when later (review 6,
  N1: a planned reading appears only once its replicates are combined); a missing one defaults to the
  evidence time. Velocity is per evidence week, while a drift d per grading week moves it by
  d·(dG/dE), the grading span over the evidence span; so its band is taken over spans [1, max(1,
  dG/dE)] with dG/dE the ratio of the concepts' mean spans on the two clocks (review 6, N3: a backlog
  growing within the window, dG/dE > 1, under-protected it; dev's within-concept dG/dE was 0.43, so
  dev is unaffected). Tested on a generator
  with no learning, a grader drifting +2/week (the interval's top) on grading time, and every reading
  after a concept's first graded after an exponential lag of mean 42 days: any flag in 3.5 % of 400
  learners and gains in 3.7 % of 16,000 comparisons, where the evidence gap alone gives gains in 17.3 %.
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
With σ_e measured at 9.9 and k = 2 everywhere, one measurement would need about +27 over one earlier.
**That is not dev today** (review 4, S2): σ_e in use is the larger stratum value, and dev's rarely-read
stratum (3 concepts, 2 pairs) is on the fallback 18, so with σ_g 6.73 and dev's median k = 1 a
measurement must rise **47.2** over one earlier (the page says "about 50+"); a per-concept flag needs
|Δ| above about 53 one at a time, more after BH. See "What a learner can be told, by regime" below. The last term is the
continuity correction for the grid: a mean of k gridded gradings moves in steps of 5/k, so without it
k_now 1 against k_before 4 fires 5.8 % of the time under no change (the threshold 12.4 sits just
below the reachable 12.5); with it every combination of k_now ≤ 3, k_before ≤ 10 fires ≤ 5 % (tested).
The +10 floor is a product rule and takes no correction. SQL `BLIND_GAIN` (a window over the
earlier measurements' Σk, Σk² Var-terms) and pure `blindGain` are twins (tested on 400 cases each
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
and the drift term is max(0, d·gap) over both ends of the interval and both gaps from the k-weighted mean
time of the earlier measurements to now: in evidence time and in grading time (review 5, S3: the panel
measures drift per week of grading time, so a linear drift d moves the compared difference by
d·(grading gap); "Which clock" above). While the drift is unmeasured (the panel's first 4 weeks: null interval) no rise is a
gain: it is `withheldForDrift`. The strip reports those per window (`withheldForDrift`, concepts not
in `up`); the feed sends no gain notification for them. Tested: the strip review's repro (k 2,
40 → 70 over 4 weeks at dev noise) is withheld under dev's drift [−4.6, +13.0] and under unmeasured
drift, and a gain at [−0.4, +0.4]; with the grader drifting at the interval's high end and no
learning (uniform grading error, Laplace evidence error) the rule fires 4.3 % of 20,000 comparisons
where the noise rule alone fires 20.8 %; a planted +45 over 4 weeks at k 2 is a gain > 75 % of the
time at [−0.4, +0.4]; the SQL and the pure rule agree on 900 cases over five noise settings and six
drift intervals (null, zero, straddling, wholly positive, wholly negative). Postgres `GREATEST`
ignores NULLs, so the SQL refuses a null drift explicitly (the twin test caught it).

**Chance gate: many comparisons per learner (review 6, S1).** The rule above fires at most 5 % of the
time per comparison under no change (1.4–3.3 % measured, below), but a learner is compared about 393
times in 8 weeks on the known-truth generator, so one who learns nothing collected **5.4–12.8 gains
beyond noise** (86–100 % of learners at least one; `gainsPerLearner` in the report, lane none). The
unit the learner experiences is the learner, not the comparison. So a surface reports gains only when
more rose than chance alone plausibly gives over its window: at least `chanceCritical(m)` of the
window's m comparisons, the smallest c with P(Binomial(m, 0.05) ≥ c) ≤ 0.05 (`CHANCE_RATE`; for
m = 2, 11, 40, 394: 2, 3, 5, 28). That is a one-sided test of "nothing changed" over the window, so
under no change a window shows a gain in at most about 5 % of looks.
- **Strip.** Per window, `up` counts concepts with a gain only when `up ≥ chanceCritical(tested)`,
  `tested` the window's comparisons (counting concepts, not gain measurements, is conservative). Else
  they are `withinChance`: no ▲, and the line says "N of M rose beyond grader noise and the drift, no
  more than chance alone gives about X". A ▲ line always quotes what chance gives beside the count
  (`chance` = 5 % of the window's comparisons, its mean under no change).
- **Feed.** A gain is toasted only when the 30 days of grading up to it (`CHANCE_WINDOW_DAYS`, in
  completion order, so the decision is fixed when it is sent) hold at least `chanceCritical` gains of
  their comparisons. SQL `FEED_GAIN` (window counts over `HISTORY`, the critical values passed as an
  array for m ≤ 4000; beyond that nothing is toasted) and the simulator's `gainTrials(...).reported`
  are twins; `mastery-change.integration.test.ts` pins both surfaces (one rise among 11 comparisons is
  `withinChance`; with three of 13 the strip shows ▲ and the feed toasts only the third, the first
  whose 30 days pass).
- **Why this and not BH or a family-wise bound per comparison.** BH over a window needs every
  candidate's p-value at once, which the online feed does not have (a toast is decided when it is
  graded, and a later gain must not un-send an earlier one), and a per-comparison Bonferroni bound over
  ~400 comparisons would need about +57 points for a single gain at σ_e 9.9 and k 2 (+27 today). The window test keeps the
  per-comparison rule and its power for learners who do learn, and it is the claim the strip makes ("N
  rose"). It is weak control: under partial learning it does not say which of the counted concepts
  rose by chance, which is why the count is printed next to what chance gives.
- **Measured** (lane none, 200 learners per row, report seeds; the pure twins): false toasts per
  learner in 8 weeks fall from 5.4–12.8 to **0.05–0.53**, learners with at least one from 86–100 % to
  **3–16 %**; a weekly look at the strip's 30-day window shows a ▲ in 65–97 % of looks before and
  **0–0.9 %** after. With the drift rule (±0.37) the same rows give 0.04–0.38 false toasts and 2.5–14 %
  of learners. The stated bound the null test holds: at most 0.8 false toasts per learner, at most 25 %
  of learners with one, and a ▲ in at most 5 % of weekly looks. The residual feed rate is the repeated
  looks of a sequential test (each gain re-tests its window), not a per-look excess. Cost: at ρ 0.7 a
  slow learner (+1 a week) gets 2.4–2.6 toasts instead of 17–18, and sees a ▲ in 8 % of weekly looks;
  medium and fast learners keep most of theirs (14–16 of 31–32, 52–54 of 68–70), and the order none <
  slow < medium < fast holds on every surface. The aggregate change and velocity lines, not the ▲,
  are where a slow learner is told (80–83 % "rose" at ρ 0.7, below).

**The Osmosis Map strip (review round 3, B2).** Its before → now figures are the **live** grader's
scores, the ones the map shows (`scores: 'live'`), labelled in the Progress page's own phrases: "your
scores from the live grader (each grading starts from the previous score; the grader alone raises a
score about +2.1 points per grading), so they are not evidence of learning" (`liveRisePerGrading`,
the measured mean move of anchored gradings). Its ▲ counts **only** prior-blind gains beyond grader
noise and clear of the grader's drift, when more rose than chance alone gives over the window (`up`;
concepts beyond noise but not clear of the drift are counted apart as `withheldForDrift`, and gains no
more than chance gives as `withinChance`, both worded by the strip; "Chance gate" above); a window without one states the prior-blind finding ("no verdict yet" while no concept was
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
average away only the grader's part of a reading's error, never the evidence's, **and only once
replicate credit is on, which needs every read-rate stratum at 30 pairs** (review 4, S2). Until then
every measurement counts as one grading whatever its k, so k = 2 and 3 buy **no** precision in any
verdict at +26–53 % input tokens per reading. Dev has 12 and 2 pairs, and in the reviewer's 8-week,
60-concept learners only 33–36 % reached credit. Once credit is on, at σ_g 6.74 and σ_e 9.9 a
measurement's variance is 143 at k = 1, 121 at k = 2 and 113 at k = 3, against a floor of 98 that
no k crosses: about 6 % less at k = 3 than at k = 2. Reading a concept more often (more
measurements, more pairs) is what shrinks σ_e's share and turns credit on, not grading one reading more.

**What a learner can be told, by regime (review 4, S2).** σ_e, and with it every per-concept bar, is
in one of three regimes; the power figures elsewhere in this spec are for the third unless they say
otherwise. A true rise of **exactly +20** at one measurement, announced as a gain (reviewer's runs,
k = 1 / 2 / 3, 60 concepts unless stated):

| regime | σ_e in use | gain bar at k = 1 | exactly +20 announced | "≥ +20 since the earlier mean" (linear 5/wk) |
|---|---|---|---|---|
| fallback (any stratum with < 5 pairs) | 18 | 47.2 (dev today) | about 5 % (dev); 14–15 % at 60 concepts | 17.5–18.9 % |
| upper bound (5–29 pairs) | 80 % bound, often 11–14 | 32.5–38.6 | 14–20 % | – |
| measured (30+ pairs, credit possible) | the estimate, e.g. 9.9 | about 27 at k = 2 | 26–30 % (16 % at 18 concepts) | 38–43 % |
| measured, low σ_e | 5.5 | – | 39.5–48.3 % | 59–72 % |

"≥ +20" is P(announced | the true rise since the mean of earlier true levels is at least 20), the
estimand of the known-truth study's 48–55 % figures; "exactly +20" is what a single step of +20 gets.

**When verdicts first become possible** (each condition gates its own line):
- **Aggregate change and velocity intervals:** 20 concepts measured prior-blind twice (dev: 19).
  Requires k ≥ 2 on the readings, since only first gradings are prior-blind.
- **A direction ("rose"/"fell", velocity up/down), per-concept flags beyond drift and gains:** the
  drift panel must be measured, from 4 weekly runs (`PANEL_MIN_WEEKS`; below that the interval is null;
  dev: 0). The half-width the rules read (the union of the item-level and week-clustered intervals,
  30 items, σ_g 6.74, median of 1,000 simulated panels) is about ±2.0/week at 4 runs, ±1.1 at 5,
  ±0.75 at 6 and ±0.43 at 8, times the span in weeks. Within one grader prompt revision only (dev has 3 revisions among the readings).
- **Gains (▲, toasts):** a rise beyond the bar above and beyond the drift over the gap; at the
  fallback bar of 47 almost none qualify. The bar falls to the upper-bound regime once every
  stratum has 5 pairs, and replicate credit (k > 1 counting) once every stratum has 30.
- **Probe headline:** 20 concepts per arm with a first-probe answer (dev: 0 of 57 taught and 0 of 12
  held out probed).

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
  reach both arms alike, so it is the equal-opportunity comparison and the only one with a server
  verdict (`conclusive`); the page gives no per-person verdict from it (one learner's holdout is too
  small, `HOLDOUT_ONE_LEARNER`). Its population is the concepts
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
  sum(probe_answer). A plain mean would score an unprobed concept 0, and most concepts of either arm
  are never probed. NB2 in GrowthBook: column `probe_percent_common_time` is the answer moved to a
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
planted, both arms are probed at 0.4 a week per concept (the scheduler since 829754b; the NB2 and
B1 tests set the old 1 against 0.25 on purpose), and the seeding
writes uncited readings (dated by the 75th percentile) and replicate summaries through
`combineReplicates`. The permanent null test asserts that the model which ignores σ_e fires far
beyond 5 % on that generator (mutation M19 is dead by construction).

`mastery-known-truth.test.ts` (fixed seeds) holds the **permanent null test**: no learning, the
ratcheting grader, taught concepts read twice as often after the start, blind probes in both arms.
At k = 2 and 3 over 100 learners, every "you improved" verdict (aggregate rose, BH upward flags, the
toast/strip gain per eligible measurement, the probe headline) fires at most about 5 %, while the live
scores rise more than +10 on average. Per learner (review 6, S1) it asserts the gate's stated bound:
more than 5 gains beyond noise per learner before the chance gate, at most 0.8 toasted after it, at
most 25 % of learners with one, and a ▲ in at most 5 % of weekly 30-day strip looks (measured on its
seeds: 0.5, 14–16 %, under 1 %). It also checks lane recovery (none 0, slow 1, medium 2.5, fast
5 points a week): rank order, slope, interval coverage, bias, power and gain sensitivity.

**Velocity at the bound (review N4).** The velocity estimand is the slope of the TRUE level at the
measured times (`trueMeanSlope`), not the planted rate: a concept near 100 stops rising, and no
estimator can recover a rise that did not happen. The lanes' slope intervals cover it (60 learners a
lane at k = 2: 92–97 %, bias ≤ 0.03 points a week). With `reachBound` the starting levels leave no
room for the rise; on the measured starting levels about 4 % of a fast learner's concepts then touch
100 and the interval still covers the bent slope (96.7 %); the test asserts both.

**The study's numbers** (`scripts/mastery-known-truth-report.ts`, 200 fixed-seed learners per lane,
k and ρ, everything in `data/mastery-known-truth-report.json`; rerun 2026-11-12 after review 6 at
**equal** probe rates, 0.4 a week per concept in both arms (review 4, S3: the design comparison, the
old run's total probes spread equally; the real graph gives about 0.5, one dev learner about 0.03,
below), as the scheduler since 829754b). The intervals allow for a sitting-shared evidence error (A,
Aggregate), as the server's do; the generator plants none, so σ̂_u is noise around 0 and widens
little (review 5's day clusters had widened these intervals by that noise, which is why the coverages
below sit 0.5–3.5 points under the previous run's and lane none is told "rose" a little more often).
ρ is the share of a single grading's variance that is evidence error: σ_e = 0, 4.9, 10.3 at σ_g 6.74;
dev measures about 0.68. In lane none, "told rose" and "gains / eligible" are false-positive rates
("rose" is one side of a 95 % interval, 2.5 % nominal: measured 2.5–5 %, all before the drift rule);
elsewhere "told rose" is power. "Gains per learner" is gains beyond noise per learner in 8 weeks →
those the feed toasts after the chance gate (A, Gain rule). k = 1 gives no verdict at any ρ (rows
omitted). No drift is planted and none is passed, so "told rose" here is **before** the drift rule
(power under it below). Change coverage is 91–99 % (mean over these rows 95.2 %), velocity coverage
92–97 % (mean 94.0 %); the 91 % cell (ρ 0, k 2, slow) is the concept bootstrap itself (91 % with the
widening off too). The faster lane shows the higher velocity in ≥ 99.5 % of learner pairs at every ρ
and k.

| ρ | k | lane | change cov. | velocity cov. | mean velocity | told "rose" | gains / eligible | gains per learner → toasted | true +20 announced | σ_e estimated (cov.) |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 2 | none | 93.5 % | 94.5 % | −0.02 | 2.5 % | 2.2 % | 8.5 → 0.04 | – | 1.9 (94.6 %) |
| 0 | 2 | slow | 91 % | 92 % | +1.00 | 100 % | 4.8 % | 18.7 → 4.48 | – | 2.1 |
| 0 | 3 | none | 94.5 % | 93 % | −0.00 | 3 % | 1.4 % | 5.4 → 0.07 | – | 1.5 (95.4 %) |
| 0 | 3 | slow | 95.5 % | 93.5 % | +0.99 | 100 % | 4.1 % | 16.1 → 5.26 | – | 1.6 |
| 0.34 | 2 | none | 93.5 % | 93 % | +0.01 | 3 % | 2.9 % | 11.5 → 0.50 | – | 5.5 (96.6 %) |
| 0.34 | 2 | slow | 94 % | 94 % | +1.01 | 98.5 % | 5 % | 19.6 → 4.83 | – | 5.4 |
| 0.34 | 3 | none | 94.5 % | 94 % | +0.00 | 3 % | 2.5 % | 10.0 → 0.38 | – | 5.5 (95.4 %) |
| 0.34 | 3 | slow | 94.5 % | 93.5 % | +1.00 | 99.5 % | 4.9 % | 19.1 → 5.56 | – | 5.5 |
| 0.7 | 2 | none | 94.5 % | 95 % | +0.04 | 4.5 % | 3.3 % | 12.8 → 0.49 | – | 11.1 (96.1 %) |
| 0.7 | 2 | slow | 95.5 % | 94 % | +1.03 | **80 %** | 4.5 % | 17.8 → 2.43 | – | 11.0 |
| 0.7 | 2 | medium | 97.5 % | 97 % | +2.51 | 100 % | 7.8 % | 30.7 → 14.45 | 1 of 4 | 11.2 |
| 0.7 | 2 | fast | 99 % | 94.5 % | +4.98 | 100 % | 17.3 % | 68.0 → 51.69 | **53.6 %** | 10.8 |
| 0.7 | 3 | none | 94 % | 93 % | +0.01 | 5 % | 3.1 % | 12.3 → 0.53 | – | 11.0 (98.4 %) |
| 0.7 | 3 | slow | 95.5 % | 94.5 % | +0.99 | **82.5 %** | 4.4 % | 17.1 → 2.58 | – | 11.1 |
| 0.7 | 3 | medium | 97.5 % | 95 % | +2.48 | 100 % | 8.2 % | 32.1 → 16.02 | 0 of 4 | 11.1 |
| 0.7 | 3 | fast | 98.5 % | 93.5 % | +4.97 | 100 % | 17.8 % | 69.9 → 53.74 | **56.4 %** | 11.0 |

**Repeated looks (review 6, N2).** Every rate above is per look. A learner who opens the Progress page
weekly from week 3 to week 8 tests the same null again each week: on review 6's generator (no
learning, session sd 8, drift ±0.47, 300 learners) an upward line (change "rose" or velocity up) is
shown at some look to 10.3 % (60 concepts) and 12.3 % (120) of null learners, against 2.7–3.0 % per
look, and is still shown at week 8 to 1 %. Not corrected (a confidence sequence would be); the strip's
chance gate has the same structure and is measured above.

**At dev's real probe rate** (about 0.03 a week per concept: one learner at the default policy;
same seeds, `--probes-per-week 0.03`, rerun 2026-11-12): false positives stay near nominal (lane none:
"rose" 1–4 %, gains 0.2–2 %), and power falls with the fewer measurements — at ρ = 0.7 the slow lane is
told "rose" 25.5 % (k = 2) and 37 % (k = 3), the medium lane 88.5 % and 93 %, a true +20 is
announced 43–44 % in the fast lane, and the fast-over-slower rank holds in 94.5–100 % of pairs. The
σ_e interval covers the planted 0 at ρ = 0 only 75–83 % of the time in lane none there (a floor effect
with few pairs).

**Power, restated (review round 2, S-e).** The previous table (σ_e = 0) claimed 100 % "rose" at one
point a week and 3.4 % false gains. With the evidence error modelled and estimated:
- False gains per eligible measurement stay at **1.4–3.3 %** in lane none at every ρ, because the
  gain rule carries σ_e (the reviewer's 19–24 % was the old rule on this generator; the test asserts
  the old rule fires > 20 % and the new one ≤ 6.5 %).
- "Rose" at one point a week is **80 % (k = 2) and 82.5 % (k = 3) at ρ = 0.7** at 0.4 probes a
  week (at 0.25 and dev's 0.03 see the probe paragraphs below: 25.5 % and 37 % at 0.03),
  and a concept whose true rise since its earlier mean is at least +20 is announced 54–56 % of the
  time instead of 99 % (this is the measured-σ_e regime and the "≥ +20" estimand, see
  "What a learner can be told, by regime": an exactly +20 step at a fallback σ_e is about 5 %).
  At equal rates fewer close pairs reach a stratum, so σ_e more often rests on the 80 % upper bound
  or the fallback: with σ_e planted at 0 a true +20 is caught 66 % of the time from the estimated
  σ_e against > 80 % when σ_e is known (tested).
- **With the drift rule** (S-b) and a measured panel, slow-lane power drops further, because a
  small rise must also clear the drift's interval times its span. Since round 4 the same holds for
  the per-concept gain (A, Drift): the last two columns are the gain rule before → after its drift
  half. 100 learners per row, equal probe rates of 0.4 a week, no true drift (`scripts/mastery-drift-power.ts`):

  | ρ | k | lane | panel | drift ± | rose | rose under rule | withheld | gains / eligible | true +20 announced |
  |---|---|---|---|---|---|---|---|---|---|
  | 0 | 2 | none | 30 × 8 | 0.37 | 3 % | 0 % | 4 % | 2.2 % → 1.8 % | – → – |
  | 0 | 2 | none | 60 × 8 | 0.26 | 3 % | 0 % | 4 % | 2.2 % → 1.9 % | – → – |
  | 0 | 2 | slow | 30 × 8 | 0.37 | 100 % | 83 % | 17 % | 4.6 % → 3.5 % | – → – |
  | 0 | 2 | slow | 60 × 8 | 0.26 | 100 % | 92 % | 8 % | 4.6 % → 3.8 % | – → – |
  | 0 | 2 | fast | 30 × 8 | 0.37 | 100 % | 100 % | 0 % | 29.2 % → 27.5 % | 91.3 % → 87.8 % |
  | 0 | 2 | fast | 60 × 8 | 0.26 | 100 % | 100 % | 0 % | 29.2 % → 28.0 % | 91.3 % → 89.0 % |
  | 0 | 3 | none | 30 × 8 | 0.37 | 3 % | 0 % | 3 % | 1.1 % → 0.9 % | – → – |
  | 0 | 3 | none | 60 × 8 | 0.26 | 3 % | 0 % | 3 % | 1.1 % → 0.9 % | – → – |
  | 0 | 3 | slow | 30 × 8 | 0.37 | 100 % | 94 % | 6 % | 3.8 % → 2.8 % | – → – |
  | 0 | 3 | slow | 60 × 8 | 0.26 | 100 % | 99 % | 1 % | 3.8 % → 3.0 % | – → – |
  | 0 | 3 | fast | 30 × 8 | 0.37 | 100 % | 100 % | 0 % | 31.6 % → 30.3 % | 97.1 % → 95.3 % |
  | 0 | 3 | fast | 60 × 8 | 0.26 | 100 % | 100 % | 0 % | 31.6 % → 30.7 % | 97.1 % → 95.9 % |
  | 0.34 | 2 | none | 30 × 8 | 0.37 | 3 % | 0 % | 3 % | 3.0 % → 2.7 % | – → – |
  | 0.34 | 2 | none | 60 × 8 | 0.26 | 3 % | 0 % | 3 % | 3.0 % → 2.7 % | – → – |
  | 0.34 | 2 | slow | 30 × 8 | 0.37 | 96 % | 71 % | 25 % | 5.1 % → 4.2 % | – → – |
  | 0.34 | 2 | slow | 60 × 8 | 0.26 | 96 % | 81 % | 15 % | 5.1 % → 4.5 % | – → – |
  | 0.34 | 2 | fast | 30 × 8 | 0.37 | 100 % | 100 % | 0 % | 25.8 % → 24.2 % | 80.9 % → 76.0 % |
  | 0.34 | 2 | fast | 60 × 8 | 0.26 | 100 % | 100 % | 0 % | 25.8 % → 24.5 % | 80.9 % → 77.0 % |
  | 0.34 | 3 | none | 30 × 8 | 0.37 | 3 % | 0 % | 8 % | 2.7 % → 2.3 % | – → – |
  | 0.34 | 3 | none | 60 × 8 | 0.26 | 3 % | 0 % | 7 % | 2.7 % → 2.4 % | – → – |
  | 0.34 | 3 | slow | 30 × 8 | 0.37 | 100 % | 87 % | 13 % | 5.1 % → 4.1 % | – → – |
  | 0.34 | 3 | slow | 60 × 8 | 0.26 | 100 % | 91 % | 9 % | 5.1 % → 4.3 % | – → – |
  | 0.34 | 3 | fast | 30 × 8 | 0.37 | 100 % | 100 % | 0 % | 28.2 % → 26.5 % | 88.9 % → 84.8 % |
  | 0.34 | 3 | fast | 60 × 8 | 0.26 | 100 % | 100 % | 0 % | 28.2 % → 26.9 % | 88.9 % → 85.9 % |
  | 0.7 | 2 | none | 30 × 8 | 0.37 | 2 % | 0 % | 2 % | 3.0 % → 2.8 % | – → – |
  | 0.7 | 2 | none | 60 × 8 | 0.26 | 2 % | 0 % | 2 % | 3.0 % → 2.9 % | – → – |
  | 0.7 | 2 | slow | 30 × 8 | 0.37 | 76 % | 39 % | 37 % | 4.3 % → 3.8 % | – → – |
  | 0.7 | 2 | slow | 60 × 8 | 0.26 | 76 % | 46 % | 30 % | 4.3 % → 3.9 % | – → – |
  | 0.7 | 2 | fast | 30 × 8 | 0.37 | 100 % | 100 % | 0 % | 17.4 % → 16.1 % | 53.8 % → 49.1 % |
  | 0.7 | 2 | fast | 60 × 8 | 0.26 | 100 % | 100 % | 0 % | 17.4 % → 16.5 % | 53.8 % → 50.3 % |
  | 0.7 | 3 | none | 30 × 8 | 0.37 | 4 % | 1 % | 6 % | 3.2 % → 2.9 % | – → – |
  | 0.7 | 3 | none | 60 × 8 | 0.26 | 4 % | 2 % | 5 % | 3.2 % → 2.9 % | – → – |
  | 0.7 | 3 | slow | 30 × 8 | 0.37 | 87 % | 42 % | 45 % | 4.4 % → 3.9 % | – → – |
  | 0.7 | 3 | slow | 60 × 8 | 0.26 | 87 % | 52 % | 35 % | 4.4 % → 4.0 % | – → – |
  | 0.7 | 3 | fast | 30 × 8 | 0.37 | 100 % | 100 % | 0 % | 18.3 % → 16.9 % | 57.4 % → 52.4 % |
  | 0.7 | 3 | fast | 60 × 8 | 0.26 | 100 % | 100 % | 0 % | 18.3 % → 17.2 % | 57.4 % → 53.4 % |

  Medium and fast lanes are not withheld. At dev's ρ, a learner gaining a point a week is told so
  about two times in five to one in two (39–52 %); the rest read "rose beyond grader noise but not beyond the grader's
  possible drift". The drift half costs the per-concept gain little once the panel is measured (a true
  +20: 54 → 49–50 % at ρ 0.7, k 2), and false gains stay at or below the noise rule's.
- σ_e is recovered without bias at ρ 0.34 and 0.7 (5.4–5.6 against 4.9, 10.8–11.2 against 10.3:
  the larger of two strata is a slight upward bias by design) and reads 1.5–2.2 when the planted value
  is 0 (a floor effect); the used stratum's 95 % interval covers the planted value 94.6–98.4 % of the time
  in lane none (90.7–99.1 % over every lane at k ≥ 2).

- **The probe headline gives no verdict for a learner of this size** (0 of 200 learners in every
  lane reaches the 20-per-arm minimum). Only the answer to each concept's FIRST probe counts (review
  round 6, S-1), and about 64 % of graded answers are low confidence, so of 159 concepts at 0.4 probes
  a week about 27 held-out ones are probed and **10.3** get a follow-up (40.7 taught), against 20
  needed (7.6 at 0.25; at the old 4× held-out rate it was 11.8; at dev's 0.03 a week, **1.5** held-out
  follow-ups and 6.1 taught). At 0.4 a learner needs about twice as many concepts (≈ 310) for the
  held-out arm to reach 20; at 0.03 the headline is out of reach for any single learner. Before the first-probe fix the headline fell through to
  later probes' answers and reached the minimum, biased (−2.3 points at half the answers read, truth
  +5). The time covariate stays in place (NB2). Its
  false-positive rate is tested at 600 concepts instead (`mastery-known-truth.test.ts`).
- **k = 1 gives no verdict in any lane**: only first gradings are prior-blind, so no concept is
  measured prior-blind twice. The live scores still rise about +13.5 points with no learning at all.
- **Rank order**: at k = 2 and 3 a learner of each faster lane shows a higher velocity than one of
  the next slower lane in 100 % of pairs (99.5–99.7 % for none against slow at ρ = 0.7).
- **Velocity coverage** is 93.5–98 % in every row above (200 learners: ±3 points of sampling noise).
  Change coverage is 94.5–100 %.
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

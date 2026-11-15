# Simulated-learner experiment

Status: batch 1 (e54225af, design v1) finished and is written up; that design is
retired and its code deleted. Batch 2 runs on the design below, which is the only
one the code implements. Its first pilot (0946448d) is void; revision 7 (see "Pilot and cost") fixed the two
validity failures it found; revision 8 screened the exam (see "The exam screen"), and the pilot reruns before any main batch. Revision 9
(2026-11-14, before any main-batch data) dropped 4 more implied items and replaced the unbudgeted check's fixed gap
with a paired guard (see "Pilot and cost"); its main batch (ccec88a3) read "inconclusive (stopped for futility)", final
for revision 9. Revision 10 (design v3, 2026-11-14) is the pre-registration the code implements now (see "Revision 10:
the pre-registration of record"). Code: `packages/core/src/lib/learning/learning-sim-*.ts`
(curriculum, fact channel, memory rules, prompts, model calls, steps, analysis),
`packages/server/src/wirings/learning-sim-learner.workflow.ts` (the durable
workflows), `packages/server/src/functions/learning/learning-sim-experiment.function.ts`
(their steps), `packages/core/src/lib/learning/learning-sim-run.ts` (the experiment run's step bodies), the
framework runtime package's `src/bin/sim-worker.ts` (the worker that executes runs), `scripts/sim-experiment.ts`
(the trigger: start, resume, health, report) and `tests/simulated-learner.test.ts` (the suite's test, with the crash
tests), tables from migration 0027.

## Questions

1. **Does Learner's knowledge injection improve understanding?** Arm `on` against
   arm `off` on a closed-book exam after the last session.
2. **Does Learner's reporting measure it accurately?** Its own statistics (the
   prior-blind measurement series, mastery changes with their intervals, gain
   notifications) against the same exam, with pre-registered pass/fail thresholds.

Real users cannot answer either cleanly: nobody takes an exam, arms cannot be
assigned per person, and real conversations differ in more than the treatment.
Simulated learners can be assigned, examined and replayed. What they cannot do
is stand in for people: every result here is about Codex models playing a
learner, and says nothing direct about humans.

**What a result means.** The learner is a language model with a capacity-limited
notebook, under the memory rules below; the result is conditional on those rules
and says nothing about a real person's memory. Learner runs the shipped policy
with `spacedRepetition` on, which is not the product default (off), so the
result says nothing about the product as shipped by default either. The
pre-registration and the report header state both.

## Design

### The subject: a fictional curriculum

"Halyard", a fictional event-pipeline runtime (`learning-sim-halyard.ts`): 13
concepts with prerequisite edges (tessel, keel key, twin rule, overbear,
rebraid, slack window, beat, mooring, draft limit, becalming, ballast check,
refit, squall), five incident briefs, a manual of concept names for the agent, a fact sheet per concept and an
exam of one question per fact (rubric 0/1/2). The sheets were written with eight facts each (104); revision 8's
screen (below) dropped 40 and revision 9 four more, so the sheets hold 2 to 6 facts and the exam has 60 questions. Fictional, so no
model knows it in advance: everything a learner knows about it came from the
conversation. Batch 1's 34 baseline exams all scored 0, so a run has no baseline exam.

It is loaded through the real curriculum tables as a GENERATED curriculum
(owner `sim-halyard`), never a seed: the API's startup and the test preload
retire every seed not in the shipped library. The live hook path takes it
through a catalog seam (`LiveCatalog`: concepts + version): `beginLiveTurn` and
`submitLiveTurnFeedback` default to the shipped catalog, so the product path is
byte-identical, and the experiment passes Halyard's.

Each learner holds out its own 3 concepts (below), passed to the live turn explicitly.

### Durable workflows, restart-safe

An experiment run is ONE durable parent workflow, `learningSimExperimentWorkflow`
(`packages/core/src/lib/learning/learning-sim-run.ts` holds its step bodies). Its
input is `{ runId, concurrency, configs }`, written once by the start
(`scripts/sim-experiment.ts`); nothing outside the workflow decides anything
after that. The levels are Pikku workflows that start each other as child runs:

0. `learningSimExperimentWorkflow`: **pin** (`pinSimRunStep`), then one
   `learningSimBlockWorkflow` per block in order, then **analyse and report**
   (`simReportStep`), whose output (`{ runId, integrityOk, markdown }`) is the
   report of record. The pin step refuses, before any model call:
   - what the database may not run (`simRunRefusal`): learner_sim takes only
     codex learners with a call cap of at most the pre-registered 6,600, the
     pre-registered looks, and sequential once a primary lane reaches the first
     look; a `learner_sim_test[_<checkout>]` database takes only stub learners;
     test wiring never runs on learner_sim;
   - code that is not the record's commit (`frozenSimChanges`, learner_sim only);
   - a second live or completed experiment run of the same run id;
   - a learner already in `learning_sim_learners` with another config, record
     included (`pinSimLearner`, `simRunDifferences`).
   It then writes every learner with the run's record (commit, `maxCalls`, k,
   sequential, arms, lanes, per-arm counts, looks), sets the policy's k, and
   returns the blocks, each split into waves of at most `concurrency` (≤ 9)
   learners.
1. `learningSimBlockWorkflow`: **gate** (`simBlockOpenStep`: runs only if every
   earlier look said continue; a block already looked at never runs again), then
   one `learningSimWaveWorkflow` per wave in order, then **the look**
   (`takeSimLookStep`, sequential runs only: the efficacy look on blocks 1..b,
   recorded once in `learning_sim_looks`; a replay adopts the recorded look).
   A learner that still fails after its retries fails the wave, the block and the
   run before the look, so a look never reads a block with a failed learner;
   `--resume` starts a new experiment run with the same pinned input, which adopts
   every receipt and recorded look.
2. `learningSimWaveWorkflow`: the wave's learners in parallel
   (`Promise.all` of child runs), so at most `concurrency` learners are in flight.
   Each sibling that settles replays the wave; the runtime's step claim
   (`LearnerWorkflowService.claimStepForExecution`) refuses a step whose child run
   is still live, so a replay never starts a second learner (core 0.12.156 would).
3. `learningSimLearnerWorkflow`: prepare (write the learner row, refuse a
   different config under the same ids, return the session plan), then one
   `learningSimSessionWorkflow` per session in order, then the summary.
4. `learningSimSessionWorkflow`: one step per action, in order: each learner
   turn and agent turn, the notebook, the exam answer and its scoring. Then, in
   arm `on` and every session but the last, one `learningSimGradeWorkflow` per
   concept, in order.
5. `learningSimGradeWorkflow`: prepare the assessment run (keyed by its request
   id `sim:<run>:<learner>:s<n>:<concept>`; nothing to grade when the concept has
   no evidence up to that session, or the same evidence as its last grading),
   then the product's `learningConceptAssessmentWorkflow` as a child run (plan
   replicates, grade, the policy's prior-blind replicates, combine, publish),
   skipped when that assessment already has a receipt, then record each
   grading, replicates included, as a counted call (`s<n>:grade:<concept>` and
   `...:r<k>`).

The budget is reserved at the channel: every paid invocation, retry and grading
reservation is checked against the cap read from the run's record in the
database (`assertSimCallBudget`); a codex learner with no cap in its record is
never called.

Every effect is keyed, so any step can run again:
- a model call writes its reservation (a pending row, counted by the cap) and
  then its receipt insert-once, under the shared attempt lease
  (`driveAttempt`, docs/operations/restart-safety.md): a step that runs again
  reads a finished receipt and pays nothing; one whose worker died mid-call
  waits for a live owner or takes the call over and adopts the detached CLI
  child's result (`runDurableCliCall`), so a finished call is never paid
  twice; only a call whose child died with it runs again (free on the
  subscription backend);
- messages are keyed by (session, seq, role), exams by their call keys, the
  learner row and grading rows by their keys;
- an assessment run is keyed by its request id and grades only evidence up to
  its session, so a replay after later sessions grades what it graded first;
- a look is a row (run, look), written once and never revised.

One process executes learner_sim's runs: the **sim worker**
(`src/bin/sim-worker.ts`), which is the product worker (`runWorker`) in the sim
environment (`src/sim-environment.ts`: database learner_sim, queue schema
`learner_boss_sim`, runtime directory `/run/learner/sim-runtime`, the scrubbed
environment of "Inputs of a real run", at most 9 workflow and CLI slots). It
takes the worker's singleton fence on learner_sim (an advisory lock held by its
own connection, so a killed holder loses it at once), recovers every run a dead
sim worker left `running`, then drains the sim queue schema. A second sim worker
waits for the fence. The stub grader, the stub transport and the test looks
(`simTest`) exist only in the test worker (`tests/sim-worker.fixture.ts`); the
sim worker never sets them, and the pin step refuses them on learner_sim.

The crash tests (`tests/simulated-learner.test.ts`) run the test worker in its
own process on the shared crash harness. (1) One learner: SIGKILL while a learner
turn's CLI child (the fake slow `codex`) is running, then SIGTERM inside a grading
(product workflow settled, rows not written), with a second fence holder
refused; every call, message, exam and grading exactly once, the killed call
adopted from its detached child (the CLI ran once; one `takeover` audit row), and
no product workflow started twice. (2) The experiment run: a stub sequential run
at test looks of 2, 4 and 6 pairs, waves of 4, SIGKILLed mid-block 2 and
recovered by a second worker; look 1 never re-taken, each look recorded once,
each learner run once, no call pending or counted twice, the record pinned on
every learner, the report as the run's output, and a second experiment run of
the run id refused.

### No exam answer outside the fact channel

- **The agent's manual is concept names only.** `HALYARD_MANUAL` lists the 13 concepts and what each builds on.
  The batch-1 manual stated 85 of the 104 exam answers; this one states none.
- **The briefs state no answer.** The five incidents no longer quote error codes, metric names or defaults. For
  example, "draft from 64" became "draft limit to 512", and `LAPSED` became "pinned reads fail with an error".
- **A suite test checks every arm's base prompt.** The test covers the agent prompt with and without the hook's
  context, and the learner's prompt, for each of the five briefs. It fails when any window of two sentences gives an
  exam answer: at least 80% of the answer's content tokens (an error code in its own case), with the question's
  concept named. Before revision 8, eight answers were exempt because they are a concept's own name ("a tessel", "a
  rebraid"); the screen dropped all eight, so none is exempt now. Its positive control is the fact sheets themselves,
  which must fail it.
- **The exam screen (revision 8; fixed before the rerun pilot, frozen with the tree).** The void pilot and the two
  revision-7 probes found unbudgeted final-exam facts that no channel fix can stop: answers a learner can get without
  the notebook. The owner's decision was to fix the exam, not the gate. Each item below is DROPPED from both the
  exam and its fact sheet, so no budget is spent on an unscored fact. Ids stay positional to the original sheets
  (`DROPPED_EXAM_ITEMS`, `learning-sim-facts.ts`). Dropping, not rewording, because a yes/no answer to a negation
  stays a 50% guess in any wording, and the rest are fewer than a rewording pass would need to re-verify.
  - Yes/no answers (21): ballast-check-f3, -f8; beat-f3, -f6; draft-limit-f4, -f6; keel-key-f7; mooring-f4, -f5;
    overbear-f3, -f4, -f6, -f8; rebraid-f6; refit-f8; squall-f6, -f8; tessel-f3; twin-rule-f2, -f4, -f7.
  - Answer in material every arm sees (a task title, a brief or the manual; 9): becalming-f2, keel-key-f8,
    rebraid-f1, -f4, slack-window-f3, -f5, tessel-f1, -f7, twin-rule-f8.
  - Answer in its own question (1): squall-f5. Answer is a concept's name (2): becalming-f7, tessel-f6.
  - Answer in another scored item's question (3): draft-limit-f2, keel-key-f5, tessel-f4.
  - Implied by a delivered fact, only the pairs observed in the void pilot and probes (4): twin-rule-f3 and
    twin-rule-f6 from twin-rule-f1; overbear-f7 from squall-f4; refit-f5 from refit-f6. No general implication
    table is built; a new implied pair is a limit (Known limits), never a post-hoc drop once a main batch has data.
  - Revision 9 (2026-11-14, a pre-launch amendment, before any main-batch data): implied by a delivered fact in the
    rerun pilot df6e6374 (4). All 7 unbudgeted final-or-interim incidences (6 items) over its 55 exams were reviewed
    pooled over arms, by item id and the same-concept facts delivered before that exam, never by arm or score:
    rebraid-f8 from rebraid-f2 (a worked instance of epoch + 1); slack-window-f4 from slack-window-f1 (a worked
    instance of the 3 beats); ballast-check-f1 from ballast-check-f2 (the ballast is a hash, i.e. a fingerprint);
    refit-f3 from refit-f4 and ballast-check-f6, which it implies in turn (dropping refit-f3 closes both incidences).
    Kept: mooring-f7 (no delivered fact gives its answer). The 4 account for 6 of the 7 incidences.
  - **A suite test runs the screen mechanically** ("revision 8: no scored item can be answered without the
    notebook", learning-sim-rules.test.ts). It flags an item whose answer is yes/no, appears in a task title, brief,
    the manual or another scored question (after stripping articles, parentheticals and filler words), or is a
    concept's title. It asserts that no scored item is flagged, that the implied ids are absent, and, as its positive
    control, that each non-implied dropped item, put back, is flagged for its recorded reason. A new leaky item fails
    the suite.

### The budget is enforced at the channel

- **Fact sheets are the only source of facts.** Revision 10 (design A2): every arm sees all 13 sheets on every turn
  while the session has budget left, and none once it is spent.
- **Each session has a budget** of `round(capacity / 50)` facts: slow 2, medium 4, fast 8.
- **An arm-blind matcher reads every reply before the learner does** (`learning-sim-matcher.ts`). It knows nothing of
  the arm or the policy.
  - A sentence, read with the one before it, states a fact in two cases: it holds at least 60% of the fact's content
    tokens with the fact's concept named, or 85% outright. It also states a fact when it gives that fact's exam answer
    with the concept named.
  - The matcher finds each of the 60 scored facts in its own text and nothing else.
  - A sentence that states an unoffered fact, or a fact past the session's budget, is replaced by `[…]`.
  - A fact already counted this session is free to repeat. A fact taught in an earlier session counts again.
  - What the channel kept is what was taught (`statedFactIds`).
  - Revision 8, review 6 B2: the kept sentences are joined without merging (a space after a sentence end or the
    marker, a newline after any other line), and the joined text is matched again; a piece in which the matcher now
    finds a fact the record does not hold is redacted too, its budget returned. Before, a space join could merge two
    kept line fragments into a sentence stating a fact that had been redacted elsewhere (4 cases on the void pilot's
    replies).
- **The agent's own list is believed, and measured.** `statedFactIds` in the reply schema is an enum of the ids offered
  that turn; the agent is told to list every sheet fact it states, in any wording. A claimed fact the matcher did not
  find anywhere in the reply is placed in the sentence holding most of its tokens not already explained by the facts
  found there, and is budgeted or redacted there like any other (`attributedFacts`). The claims are kept as
  `claimedFactIds`; the report gives the share of valid ids and the share the matcher found on its own. Why (revision
  7): in the void pilot 0946448d, 20 of the 26 final-exam facts that were right but never delivered were facts the
  agent had claimed and stated in paraphrase; the lexical matcher neither redacted nor counted them. Re-run on that
  pilot's raw replies, the claim accounts for all 20 (14 budgeted, 6 redacted); the 6 unclaimed stay a residual that
  the next check measures. Believing a claim never lets an extra fact through: a false claim spends budget or
  redacts a sentence. Its one cost: a false claim kept within budget counts a fact as delivered that was not, which
  could hide an unbudgeted one; `attributedFacts` and the share the matcher found on its own show how much rests on
  claims.
  Revision 8, review 6 B1: a claimed, offered fact the learner never read (its sentence was redacted for an unoffered
  fact, or the claim had no sentence to place it in) is recorded as `withheldFacts`, neither delivered nor over budget,
  and the channel gate accounts for it. Replayed on the 175 stored raw replies of runs 0946448d, 28f58f3b, c79a615f and
  5f6242db (no model call), the channel gate counts 0 unaccounted claims and 0 over-budget facts kept (on the void
  pilot's 135 replies the reviewer counted 18 and 4 before the fix).
- **Unbudgeted knowledge is the independent check.** It counts exam facts scored 2 (not a declared guess) that the
  channel never delivered within budget up to that exam. It is reported per session and by arm. This catches what the
  lexical matcher misses: a loose paraphrase reaches the learner unredacted and shows up here. It is pre-registered
  to be about 0 and balanced in the primary cells (revision 9's paired guard, under Pre-registration). If it is not,
  the verdict is withheld.

### Memory rules (fixed before any arm comparison)

`MEMORY_RULES` in `learning-sim-memory.ts`. The values were set before the ceiling simulator first ran and before any arm
was compared. They were not changed after.

- **(iii) Forgetting high enough that revisiting matters.** Each session gap (5 simulated days) loses an unrehearsed
  fact with probability slow 0.30, medium 0.25, fast 0.20.
  - Why: retention of new declarative material after several days without review is typically well below 80% in
    forgetting-curve studies (Ebbinghaus 1885; replicated by Murre and Dros 2015).
  - Batch 1's 0.05 (medium) would keep 81% of facts over four gaps, so revisiting could not matter.
  - At 0.25 an unrevisited fact survives four gaps with probability 0.32 (a half-life of about 12 days). The faster
    lane forgets less, as in the batch-1 lanes.
- **(ii) Spacing.** Each later session in which the channel re-delivers a fact the learner still holds multiplies that
  fact's forget rate by 0.5.
  - Why: the spacing effect (Cepeda et al. 2006, meta-analysis): a spaced re-study lowers later forgetting. Halving per
    re-exposure is the simple multiplicative stability form used by expanding-interval schedulers (SM-2's interval
    growth, the half-life regression of Settles and Meeder 2016).
  - The strengths are stored with each notebook.
- **(i) Prerequisite dependence.** A new fact is kept with probability 0.5 when some direct prerequisite of its concept
  (the curriculum's edges) has no fact in the notebook yet. Facts noted earlier in the same session count. The fact
  still uses capacity: the reading cost is paid.
  - Why: knowledge-space and learning-hierarchy theory (Gagné 1968; Doignon and Falmagne 1985). New material is learned
    less well without its prerequisites. 0.5 is the midpoint between no dependence (1.0) and a hard gate (0).
- **What the rules read.** Only the notebook, what the channel delivered (matcher ids), and the curriculum's edges. The
  arm is never visible to them.

**Ceiling and sensitivity (no-model simulator, `learning-sim-ceiling.ts`; revision 10, design C.1, D.10, D.11).** The
simulator uses the same briefs, Williams rows, holdout, budget, capacity, memory rule (`updateHeld`) and exam as a run,
and the run's estimand: the AUC item-mean (the mean of the five post-session exams, each 100 × held items / 60). Each
session a policy makes a plan of sheet facts. The simulated agent states each planned fact with probability
`compliance`, then fills the budget with random facts of the brief's concepts (each slot a random direct-prerequisite
fact instead, with probability 0.1). `off` has no plan. Learner k of every policy shares its design and every memory
draw (key `ceiling:k|lk`), so the gains are paired. Every policy plans by the product's graph, concept by concept, each
sheet in sheet order (no policy but `omniscient` reads a fact's length):
- `anchor`: `anchorPlan`, the anchor arm's own directive (below, "Arms"), from the true held facts after the previous
  session. One function feeds the arm and the simulator.
- `hook` (the shipped default's proxy): the product's `selectPrerequisites` under
  `prerequisitePolicy(LearningPolicySettings.parse({}))` (up to 2 unmet prerequisites within 2 hops), on simulated
  readings (from session 2 each concept is read with probability 0.7, at its true held share + N(6, 17)), then the
  brief's non-held-out concepts.
- `static`: the hook proxy with no reading ever (the like-for-like static prerequisite-first prompt). It plans exactly
  as the hook proxy whenever nothing is read (a unit test).
- `nudge`: one fact of a random direct prerequisite of the brief, no readings (a smaller plan, not like for like).
- `placebo`: one fact of a random concept that is neither in the brief nor an ancestor of it.
- `omniscient`, the upper bound, always followed: it reads the held facts and knows the rules (greedy on expected final
  exam points, shortest facts first within capacity).
Simulator rows only: no run has a `hook`, `static`, `nudge` or `placebo` arm.

Fast lane, 1,000 matched learners per policy (`bun packages/core/src/lib/learning/learning-sim-ceiling.ts 1000`).
Cells: the AUC item-mean gain over `off`, points (d/sd of the paired gain). At the design's compliance (anchor 0.8, every
other plan 0.6):

| rules | off AUC / final | anchor | hook | static | nudge | placebo | omniscient |
|---|---|---|---|---|---|---|---|
| all rules | 12.6 / 18.8 | 3.47 (0.95) | 3.73 (0.93) | 4.07 (1.05) | 1.33 (0.38) | 0.21 (0.06) | 13.74 (3.57) |
| forgetting off | 16.3 / 27.7 | 4.72 (1.09) | 4.79 (1.01) | 4.49 (1.00) | 1.67 (0.39) | 0.41 (0.10) | 17.92 (4.86) |
| spacing off | 12.5 / 18.6 | 3.51 (0.96) | 3.72 (0.94) | 3.95 (1.03) | 1.33 (0.38) | 0.19 (0.06) | 13.71 (3.58) |
| prerequisites off | 20.6 / 29.7 | 0.36 (0.16) | 0.71 (0.30) | 0.42 (0.18) | 0.25 (0.12) | 0.24 (0.11) | 7.48 (3.27) |
| graph perturbed | 11.9 / 18.3 | 2.01 (0.58) | 3.06 (0.82) | 3.45 (0.94) | 0.40 (0.14) | 0.52 (0.17) | 13.68 (3.78) |

Every plan followed (compliance 1):

| rules | off AUC / final | anchor | hook | static | nudge | placebo | omniscient |
|---|---|---|---|---|---|---|---|
| all rules | 12.6 / 18.8 | 3.54 (0.95) | 3.58 (0.82) | 3.12 (0.79) | 2.14 (0.59) | 0.40 (0.12) | 13.74 (3.57) |
| forgetting off | 16.3 / 27.7 | 4.82 (1.14) | 4.37 (0.84) | 1.98 (0.45) | 2.70 (0.63) | 0.65 (0.16) | 17.92 (4.86) |
| spacing off | 12.5 / 18.6 | 3.60 (0.97) | 3.58 (0.83) | 2.88 (0.73) | 2.13 (0.60) | 0.36 (0.11) | 13.71 (3.58) |
| prerequisites off | 20.6 / 29.7 | -0.01 (-0.00) | 0.62 (0.26) | -1.60 (-0.65) | 0.42 (0.20) | 0.46 (0.21) | 7.48 (3.27) |
| graph perturbed | 11.9 / 18.3 | 1.92 (0.55) | 3.06 (0.77) | 2.89 (0.79) | 0.69 (0.23) | 0.83 (0.26) | 13.68 (3.78) |

What the tables say:
- **They reproduce the design's planning values** (design D.10, scratch `rev10sim2.py`/`grid6.py`, 1,000 pairs, an
  independent implementation in Python with its own random streams): anchor 0.92 (+3.48), hook proxy 0.91 (+3.66),
  static 1.04 (+3.98), nudge 0.41 (+1.38), placebo 0.12 (+0.38). Every row agrees within Monte Carlo error: the standard
  error of each gain is about 0.12 points per implementation, about 0.03 in d/sd; the placebo's +0.21 against +0.38 is
  the largest gap, about 1 SE of the difference. Three known differences remain, all small: the scratch draws its
  holdout and task order at random where this uses the stratified holdout and Williams rows; its hook proxy drops named
  concepts from the selected prerequisites before taking 2, where the product's `selectPrerequisites` may select one;
  and the scratch's anchor also planned around held-out brief concepts (their ancestors and reviews), where `anchorPlan`
  never does (it changes the plan only in states with a held-out brief concept: 38 of 360 run-like states).
- **Almost all of every plan's gain comes from the prerequisite rule.** With it off, no plan gains more than 0.71 points
  at the design's compliance.
- **A static prerequisite-first prompt does at least as well as the hook proxy at the design's compliance** (1.05
  against 0.93). The readings add nothing in this model. At full compliance the hook proxy is ahead (0.82 against 0.79),
  because a static plan keeps re-teaching prerequisites already held.
- **The plans rely on the product's graph being the true one** (`graph perturbed`: the anchor falls from 0.95 to 0.58).
- These are planning values, not predictions: the compliance and the agent's fill are guesses about LLM behaviour.

### Lanes

A lane is a notebook capacity (characters of new notes per session: slow 100,
medium 200, fast 400) and a forget rate (`MEMORY_RULES`). Facts are kept whole, in
delivery order, skip-and-continue: a new fact that does not fit in what is left
is recorded as over capacity and skipped (never truncated), and a later one
that fits is still kept. The budget is in characters because, given a count of facts,
the model packed two or three facts into each sentence (calibration 34b55389).
Forgetting is a deterministic draw per (learner, topic, fact, session), so a
replay forgets the same facts. The learner writes its next facts after
forgetting and does not know what it lost. A restated fact costs no capacity.

### Randomization and the exam

- **Holdout.** Each learner holds out 3 of 13 concepts, passed to the live turn explicitly. The k-th learner of every
  arm in a lane shares one holdout block (one seeded permutation per lane), so arms are compared on matched designs.
- **Arm** is randomized within lane.
- **Task order** is a Williams design over the five briefs (10 rows). Over 10 learners, each brief takes each session
  position twice and follows every other brief equally often, so first-order carryover is balanced. Per-arm counts
  that are multiples of 10 balance it exactly.
- **Five sessions, 3 turns each, on a simulated calendar.** Sessions are 5 days apart. Turns, submissions and messages
  carry calendar time, so spaced repetition can fire.
- **The exam.** There is no baseline exam: an empty notebook scores 0 (all 34 batch-1 baselines scored 0).
  - Every answer says whether it is a guess, and a declared guess scores 0 (21 items are yes/no).
  - One exam in ten, chosen by a deterministic draw, is scored a second time blind to the first. The report gives the
    item agreement.

### Arms

- **`off`**: no Learner.
- **`on`**: the shipped policy with `spacedRepetition` on. It is the only arm that grades, after every session except
  the last. **on minus off is the effect of the whole hook**: its text, its guidance and its mastery readings
  together.
- **`anchor`** (revision 10, design C.1): no Learner. Before each reply its agent gets a TEACHING PLAN computed by code
  (`anchorPlan`, `learning-sim-ceiling.ts`) from the facts the learner TRULY held after the previous session and the
  graph: the unheld prerequisites (direct or indirect) of the brief's non-held-out concepts, at most 2 concepts and 2
  facts each, then those concepts' unheld facts, then their held facts, each in sheet order, never a held-out concept.
  Facts this session already delivered are dropped and the rest is cut to the budget left (`anchorDirective`,
  `learning-sim-prompts.ts`; `meta.plan` records the ids). It goes through the same agent, channel and matcher; it makes
  no live turn, match call or grading, so its planned calls are `off`'s. It measures whether a followed, explicit fact
  list moves this instrument; it is not a Learner arm. (Revision 9's `oracle` and `blind` arms are deleted.)

The agent is free to ignore the injection in every arm.

**The never-learns control (revision 7, the owner's request; `SIM_PREREGISTRATION.negativeControl`).** Lane `none`:
notebook capacity 0, so nothing is ever written, and teaching budget 0, so no fact sheet is offered and the channel
redacts every fact. It runs arm `on` through the same workflows as every learner (sessions, the live hook, the product
grader, the exam): it converses and answers but retains nothing. No new workflow or function: it is a lane value
(`SIM_LANES.none`, `factBudget('none') = 0`) and a runner count (`--per-arm-none`). It enters no other estimand,
check or gate; its calls count in the cost and the cap. Its gate, stated before any data:
- **Exam:** no exam gain. The 95% percentile bootstrap interval of the cell's mean whole-exam gain covers 0 (its lower
  end ≤ 0; with one learner, its gain is 0). With 2 learners that holds when at least one scores 0.
- **Mastery:** Learner reports no change. 0 notifications (gain or first clear), 0 concepts whose change is beyond
  noise (after FDR) and upward, and no learner whose aggregate change interval lies above 0. Its n (re-review 5):
  a control learner over 5 sessions has at most 56 planned gradings (112 for the 2 in the pilot or the main batch,
  by `--dry-run`; an upper bound, since a concept with no new evidence is not regraded) and no blind probe (a session
  with nothing delivered before it asks none). Every notification would come from one of those gradings.
- **What a failure means:** of the mastery part, that the grader or the report rewards talk without knowledge; of the
  exam part, that the exam scores knowledge no notebook holds. In the pilot both are a gate (a failure voids it). In
  the main batch the exam part is a pre-registered check (a failure withholds the primary verdict) and the mastery
  part makes the claim-2 change verdict read "inaccurate".

### What each role sees (the validity argument)

| Role | Sees | Never sees |
|---|---|---|
| Learner (Sam), writing a message | its notebook, the task brief, its own earlier messages this session, the questions in the agent's latest reply only (B5) | any explanation by the agent, the manual, the fact sheets, the exam, the arm, Learner's injected text |
| Learner (Sam), updating the notebook | the whole session's conversation and its notebook | the same as above |
| Learner (Sam), answering a blind probe (B6) | its notebook and a content-free question naming one concept | the conversation (there is none yet), everything above |
| Agent | the manual of concept names, the brief, the conversation, the fact sheets offered this turn (within budget); Learner arms: the hook text and guidance | the exam, the notebook |
| Exam scorer | questions, rubric, answers | arm, notebook, conversation |
| Learner's grader | the product's prompt over the selected evidence | arm, exam, injected guidance |

Evidence for a grading is term matching over the learner's own turns and the
agent reply after each, up to the graded session (a stand-in for retrieval).

**Sam writes from memory (B5).** A batch-1 audit found 82% of the grader's
cited evidence restated the agent's text from the same session (token overlap
0.7 or more), against 0.21 for the owner's own messages. Sam had the whole
session's explanation in its prompt and was told to end with its decision and
reasoning. Revision 6 showed Sam only the agent's latest reply and told it not
to paraphrase it; the void pilot 0946448d still measured a mean of 0.52 (21% at
0.7 or more), 0.66 and 16 of 45 at 0.7 or more on the turn after the agent's
first full reply. So Sam now sees only the QUESTIONS of the agent's latest reply
(its sentences ending in "?"), never an explanation, and is told to answer
them, say what it will do and what it is unsure of from its notebook, and not
to restate the task or the agent. What Sam keeps of a reply still reaches it,
after the session, through the notebook update, which reads the whole session.
A pilot gate (`learnerEcho`) measures it on each Sam message that has an
earlier agent message in its session, both on all messages and on the
length-matched subset (25–50 content types), with the thresholds unchanged:
- at most 5% of messages have a plain overlap of 0.7 or more (the share of the
  message's content-word types found in the previous 3 agent messages);
- the mean share of the words Sam INTRODUCES (content types not in the
  session's brief and not in Sam's own earlier messages of the session) that
  are found in those agent messages is at most 0.35.

**Why the mean changed measure (revision 7, a gate change, decided before the
rerun).** The plain overlap has a floor that no learner can get under: the
agent reuses the brief's words, so in the void pilot a message written before
any agent text (the opening turn) overlapped the next 1 and 2 agent replies of
its session at 0.31 and 0.47. A first probe of the questions-only Sam (run
28f58f3b, 1 learner, 10 messages) had no message at 0.7 or more, and its words
from the agent beyond the brief and its own earlier words were 0.13 of its
types, yet its plain mean was 0.45. The new mean is not looser for an echoing
learner: on the void pilot it is 0.43 (fails), against 0.23 on that probe. The
share criterion stays on the plain overlap, where the void pilot measured 21%.
The plain mean is still reported (the owner's messages: 0.21).

### Model calls

Every call goes through Learner's LLM layer with the backend set to the Codex
CLI (the owner's ChatGPT subscription): `callLLM(... backend: 'codex')` for the
roles, and the product's assessment service for grading. Every call is keyed
(run, learner, call key) in `learning_sim_calls` with model, effort, tokens,
duration and attempts. Capacity failures ("high demand", 429, 503, stream
disconnects) are retried in the step after 30 s and 60 s; after that the step
fails and the workflow retries it 3 minutes later (5 retries). Only catalogued
models are used: an uncatalogued name such as `gpt-6-luna` is silently
remapped by the CLI (to `gpt-5.6-sol`). `--max-calls` is a hard cap on the
run's model calls of every role, the grader's included: at the cap a stored
receipt still answers and no new call starts. A grading runs the product's grading path, which
may make one validator repair call per grading (main and each replicate) without a cap check of its own. Before a
grading starts, its worst case (2 × gradingReplicates calls) is checked against the cap and written to the ledger as
a pending row of the grading in one transaction under an advisory lock on the run (revisions 8.3 and 8.4), so of
gradings prepared at the same instant only those within the cap start, and every later call sees the reservation.
When the grading settles the row is set to what it paid: 1 per main call and per replicate, plus 1 for a validator
repair (revision 8.2; before it, the pilot's ledger missed 3 such calls of 126), plus 2 per lease takeover, i.e. a
call re-run after its worker died, whose dead worker may have paid its call and a repair the final receipt does not
show (revisions 8.3 and 8.4; an over-count when it paid less). The cap counts a reservation; the retry share r, the
health look's call counts and the cost models do not (a reservation is not a call), and the health look shows the
gradings reserved and not yet recorded on a line of their own.

Defaults: learner `gpt-5.6-luna` low, agent and scorer `gpt-5.6-luna` medium,
grader the product's default (`gpt-5.6-luna` xhigh).

### Isolation

- Writes happen only on `learner_sim` (the sim worker, derived from `DATABASE_URL` by `sim-environment.ts`)
  or `learner_sim_test_<8 hex>` (the suite's test database from `own-test-database.ts`: one per test run where the role may create it, else one per checkout): `assertSimDatabase` refuses any
  other database. The owner's `learner` database, the shared `learner_test`
  (a fictional curriculum there is read by every other test file) and the live
  services on :3010 are never touched.
- The runner has its own pg-boss schema on `learner_sim` and drops
  every `LEARNING_*` feature flag, schedule flag and foreign database URL from
  its environment. Automatic assessment, exposure drains or vector turns would
  otherwise add model calls and readings the experiment does not control.
- The runner unregisters the telemetry outbox: simulated calls are recorded in
  `learning_sim_calls` and never reach the owner's Langfuse traces.
- Simulated users are `sim-<run8>-<learner>`.

## Pre-registered analysis

### Revision 10: the pre-registration of record

Revision 10 (design v3, 2026-11-14) is the pre-registration the code implements now. `SIM_PREREGISTRATION`
(`learning-sim-analysis.ts`) holds it word for word and every report prints it; where the subsections below this one
describe revision 9 (the whole-exam primary, the delivered-only check, the unbudgeted guard, the noise gate, the
never-learns control's exam part, the oracle and blind arms, the slow and medium rows), revision 10 replaces them and
their code is deleted. **Revision 9's result is final for revision 9:** run `ccec88a3-652a-4d31-b88d-0d70ee4d9f1d`,
"inconclusive (stopped for futility)". It is never re-analysed under revision 10's estimand.

**What carries over (design D.1).** Durable workflows and restart safety; the frozen tree, the void rule and the run
record pinned in the database; arm-blind health looks; efficacy looks by code at block ends; the fact channel's matcher
and budget (8 per session, fast lane); the curriculum, the 60 items, the briefs and the manual; holdout 3, Williams
order, 5 sessions of 3 turns, the simulated calendar; the grading mechanics, channel, valid-id and B5 echo gates; claim 2's
three-criterion conjunction.

**What is new.**
- **The instrument (A-full).** The exam is computed from the facts the memory model holds, and the memory model reads
  only verified delivered fact ids (`statedFacts`, with each delivery's path: `matched`, `matched-claimed`,
  `attributed`). Its draws are keyed by pair and fact id, so arms `on` and `off` of a pair face the same draws.
  `replayExams` recomputes a learner's exams from its stored deliveries; with no override it reproduces them exactly.
- **Arms.** `off` (no hook), `on` (the shipped default policy: `LearningPolicySettings.parse({})`, spaced repetition off,
  `foundationFirst: false`) and `anchor` (a true-state fact list, Learner off, no verdict). The never-learns control
  (lane `none`, arm `on`, 2 learners) is kept.
- **Primary.** G, the AUC item-mean: per learner the mean of the 5 post-session exams, each 100 × items held / 60. The
  primary is the mean over the matched fast-lane pairs of G(on) − G(off), paired t. The smallest effect of interest is
  2 points.
- **Sequential design.** Looks at 12, 24 and 36 pairs (blocks of 12, 12, 12); O'Brien-Fleming at one-sided alpha
  0.02474 (the programme's 0.025 minus the 0.00026 revision 9 spent at its look 1): c = 2.0083, boundary z 3.478 / 2.460 /
  2.008, nominal p 0.000252 / 0.006955 / 0.022308. c is solved by Simpson integration of the partial-sum process on a grid
  that ends on the boundary (`obfConstant`); its spend without futility is 0.02474. False-positive rate (2.35% at the
  test's seed), power and the stop bias are pinned by seeded tests.
  - **Correction of 2026-11-14** (statistics review RC1), made before any revision 10 data existed, in the conservative
    direction: design D.4 printed c = 2.0074 (z 3.477 / 2.459 / 2.007, p 0.00025 / 0.00697 / 0.02235). That is the value of
    a step-0.02 grid that stops short of the boundary. It spends 0.02479 without futility, and the programme total would
    then be 0.02505 > 0.025. The exact c is a little larger. The cross-check at alpha 0.025 is against the exact values
    too: c 2.0040, z 3.471 / 2.454 / 2.004. The design's grid gave 2.0039 there, with the same z to 3 decimals, because
    its error at 0.025 is only −8e-6.
- **Gatekeeping.** "Supported" also needs the final item-mean (E_5) paired estimate ≥ 0 and its 95% lower bound > −2;
  otherwise "inconclusive (faster early, final exam not non-inferior)".
- **Sensitivity (D.6).** Version (i) matcher-only drops every `attributed` delivery; version (ii) volume-matched
  truncates each pair's two delivery sequences, session by session, to the smaller count; version (iii) reports each
  arm's path shares. "Supported" is withheld when (i) or (ii) has a 95% lower bound ≤ 0 or not computable, or when the
  arm-blind judge's rule fires (156 calls after the stop: on's weighted false-delivery share above off's, more than 2 of
  6 planted false pairs said "yes" or of 6 planted true pairs said "no", or an item unanswered). "No effect of 2 points
  or more" also needs the 90% intervals of (i) and (ii) inside ±2 (N1); otherwise "inconclusive (sensitivity versions
  disagree)". The report lists every withhold rule that fired, even on a null primary (N3), and prints version (i)
  beside the primary with its signed difference (N4).
- **Judge mechanics (`SIM_PREREGISTRATION.sensitivity.judgeMechanics`, printed in the report).** One seeded stream
  `${runId}|judge`; the pool in canonical order (learner id, session, turn, delivery order); a short attributed stratum
  backfilled only from the same arm's matcher stratum; the delivered window at its path's bar; the planted-false rule
  (another concept's fact the window does not state even at 0.4); `judgePrompt` on the judge's view (`judgeView`: every
  sheet id, fact or concept, in any case and not glued to a word character, removed with the whitespace before it, and
  a bracket that held only ids with it; nothing else changes, so a text without an id reaches the judge as delivered;
  the stored reply, the matcher, the scores and the sample read the text as delivered); the run's agent model. Answers are read
  from the `judge:<i>` rows over every index of the sample. A final judge failure (only: the cap reached, a codex run with
  no cap, a reply refused after its re-ask, a claim refused after 3 takeovers) is unanswered and fires "judge
  incomplete"; a restart, a dead wrapper or a transport error never makes an item final. The bootstrap resamples items
  although deliveries cluster by learner: anti-conservative for the withhold, so conservative for "supported".
- **Decomposition (D.7).** The primary recomputed on the same deliveries with the prerequisite rule switched off
  (absorb = 1), printed beside it with the share carried by the rule.
- **In-batch anchor check (D.8).** Anchor minus off on G over pairs 0-9, computed after the stop only. A null reading
  whose 90% lower bound is ≤ 0 reads "inconclusive (testbed sensitivity not confirmed; programme stopped)". It never
  touches a "supported".
- **The verdict sentence** carries a fixed qualifier and the configuration's name: "Learner's live hook, in its shipped
  default configuration (not a tuned configuration), changed the agent's teaching in a way this fixed memory model
  (which taxes facts whose direct prerequisite is unheld) rewards: +X [95% CI] AUC points; +Y points remain when the
  prerequisite rule is switched off on the same deliveries (D.7). This design cannot attribute any of it to Learner's
  mastery readings."
- **Claim 2.** Verdict 2a, "grader change-tracking on scheduled probes", on each learner's probe user; verdict 2b, the
  live user's change report, with its coverage. The probe draw (P5): one uniform draw per pair and probe key; each
  learner takes that quantile of its own delivered concepts; the same rank only when the two learners' sets have the
  same size. C8: 2a's Spearman criterion (95% learner-bootstrap lower bound > 0 at n ≥ 30) reads "not computable" when
  that bound is NaN (one learner, or every change tied), never "inaccurate"; any other failed criterion still reads
  "inaccurate".

**Sizes and calls.** Pilot: fast `off` 12, `on` 3, `anchor` 12, 2 controls, the judge off: K = 1,495 planned keys, cap
ceil(K × 1.05) = 1,570. Main batch: fast `off` 36, `on` 36, `anchor` 10, 2 controls, sequential, the judge on: K =
6,062 (judge 156), `--max-calls` = ceil(K × (1.05 + r)), at most the hard cap 6,600. **Cap floor:** the pin step
refuses a paid run whose `--max-calls` is below ceil(K × 1.05) (pilot 1,570, main 6,366) or above the hard cap 6,600.
The floor is a lower bound only; the pre-registered caps above are unchanged (pilot 1,570; main ceil(K × (1.05 + r)),
6,384 at r = 0.003). `--dry-run` prints K by role (a
test pins both).

**The pilot gates (design C.2, C.4, C.5).** A gate that cannot be computed fails.
- **C.2, the anchor gate:** over 12 complete anchor/off pairs (pairs 0-11), the paired t of anchor minus off on G ≥ 1.65
  and the mean > 0. It reads arms `anchor` and `off` only. Passing shows that a followed explicit fact list moves this
  instrument by at least the main batch's MDE; it does not imply that the main batch has power for the hook. Over two
  iterations a null testbed passes 12% of the time.
- **C.4, the dose gate** (mechanism only, it reads no exam): the 3 `on` learners' pooled share of delivered facts on
  concepts the session's brief does not name, minus their 3 matched `off` learners' share, ≥ +3 percentage points
  (rounded to 1e-9, so a floating-point +2.999… is +3.0). A failure is terminal for claim 1: "the shipped guidance is not
  executed by this agent (dose difference X pp)". It is a weak screen: revision 9's hook would have passed the dose gate
  (+5.0 pp: `on` 46/374 = 12.3% against `off` 27/372 = 7.3%).

  | guidance compliance | P(dose gate passes) | P(main batch supported) | P(supported), whole programme |
  |---|---|---|---|
  | 0 | 15% | 2.6% | about 0.4% |
  | 0.05 | 50% | 23% | about 12% |
  | 0.10 | 78% | 67% | about 52% |
  | 0.20 | 97% | 94% | about 91% |

- **C.5, carried over:** gradings settle and arm `on` has a non-null reading from session 2; the channel gate; valid
  ids ≥ 95%; the B5 echo; the never-learns control (mastery part only: its exam is structurally 0 under A-full). The B5
  echo gate is unchanged under A-full (N6): an echo failure is a pilot gate failure, never a tuning point.
- **The pilot report prints no exam-derived number for arm `on`**, pooled or by arm (a test changes `on`'s exams and
  finds the same report).

**The iteration rule (design C.6, R4).** Enforced by the run's first step on learner_sim (`simIterationRefusal`):
- 2 pilot iterations in total, whatever the gate. Each has a new run id and declares the revision-10 runs before it with
  `--after` (the record's `run.after`); the iteration-log query must find exactly those, or the start is refused.
- A dose failure (C.4) in either iteration stops claim 1: no iteration and no main batch may follow. Any gate failure in
  iteration 2 stops claim 1. A pilot that passed is followed by the main batch, never a second pilot.
- Iteration 2 may change only, after a C.2 failure, the anchor directive's presentation (wording and format, never its
  fact choice) or the pre-declared K6/cap800 rung: `learning-sim-prompts.ts`, `learning-sim-memory.ts`,
  `learning-sim-design.ts`. After a C.5 failure, a reviewed code fix on the failing gate's code path: nothing in the
  memory rules, the matcher, the exam, the anchor's fact choice, the hook or the prompts, and never
  `learning-sim-analysis.ts` or `learning-sim-sequential.ts` (statistics review RC2) (`SIM_ITERATION_SCOPE.outOfScope`);
  if one is needed, iteration 2 fails. Tests may always change. Never anything after a C.4 failure.
- The main batch runs only after a pilot that passed every gate, on that pilot's frozen tree exactly: no non-test change
  to any frozen file since it, `learning-sim-analysis.ts` (the pre-registration) and this spec included (review RC5).
  Tests may change. There is one main batch.
- **The pre-registration's hash** (statistics review RC2). Every run's record carries `run.prereg`, the sha256 of
  `canon(SIM_PREREGISTRATION)` (keys in sorted order: `SIM_PREREGISTRATION_HASH`). It is written once, at the start,
  into every learner's config, so a resume replays it and cannot recompute it. On learner_sim the pin step refuses a
  record whose hash is not the code's, and refuses any run after the first whose hash differs from the run before it:
  the main batch carries the passing pilot's hash. The report prints it on the frozen-code line and on every
  iteration-log line, and a real run's integrity fails when its recorded hash is not the code's.
- The gate thresholds, the anchor's selection rule, the estimand and the main design never change.

**One operator, one start.** A run id is started once: `sim-experiment.ts` refuses a run id that has an experiment run,
and the workflow's first step refuses a second live or completed experiment run of the same run id, so two starts
racing on one run id cannot both run it. Every paid (codex) call runs only on learner_sim (N5: `paidTransport` refuses
any other database before calling the model), so the iteration-log query sees every paid run.

**The report, in order.** A fixed block reprinting revision 9's run id and verdict line verbatim, then its erratum
(revision 9's verdict unchanged), every earlier confirmatory verdict and "hook configurations tested so far: 2"
(revision 9: the shipped default + spacedRepetition; revision 10: the shipped default), the scope and `foundationFirst`
sentences, the lead's decisions (dated 2026-11-14, made after revision 9's data), the disclosures below, the simulator
rows, what a positive result would and would not prove, and the programme table. Then the iteration log, built by the
pre-registered query (`iterationLogQuery`, design E.3: every run created after revision 9's first learner with an
`anchor` or `on` learner), each run with its gates, its anchor estimate with interval and its dose, read from its rows;
a run the query finds that this run did not declare is printed and flagged; the full `git diff` of the frozen paths
between consecutive runs' commits follows. Then the pre-registration, mechanism, checks, the pilot gates (a pilot), the
looks and, after the stop only, the outcome, claim 2 and the cost.

**Disclosure: estimands seen before this pre-registration** (revision 9, 10 pairs; mean on − off, SD of the
differences, within-pair r): final concept-mean (revision 9's primary) −0.80, 6.23, 0.19; final item-mean (revision 10's
gatekeeper) −0.33, 5.84, 0.05; AUC concept-mean +1.12, 4.08, 0.26; AUC item-mean (revision 10's primary) +1.30, 2.79,
0.25. The primary is the estimand on which revision 9 looks best (t about 1.47). The gatekeeping was chosen by the lead
on 2026-11-14, also after this data. The owner's statement on speed (2026-11-12, about what a future self-tuner may
optimise) was not said about this estimand or this experiment, and does not justify AUC as the primary.

**Direction of each change (design E.2).**

| change | evidence | predicted direction for `on` |
|---|---|---|
| A1 rule uptake on ids (A-full) | [sim] default proxy at 10% compliance: d/sd 0.14 rev9-like, 0.29 A-lite, 0.42 A-full | favours on (the absorb tax becomes the lever) |
| A0 CRN pairing | [sim] r 0.13-0.40 | neutral in mean; small precision gain |
| A2 all sheets offered | [data] 71% of on target slots were off-brief, and lookups delivered 7 of 59 | favours on (removes a limit only on hit) |
| A3 verified claims | [data] matcher-confirmed claims: on 50.2%, off 45.1% | a guess: probably favours on (it drops more off deliveries); version (i) measures it |
| A4 item-mean, AUC | [data] rev9 −0.80 to +1.30 across the four estimands | favours on |
| B7 shipped default instead of the candidate | [sim] 0.91 against 0.61 at equal compliance | favours on in the simulator; chosen for relevance, not size |
| B2 honest fallback | none | unknown (text only) |
| B4 spaced repetition off | [data] its 59 review turns moved no budget in rev9 | about neutral |

Every change with a known direction points toward `on`. The guards are the gatekeeping, the sensitivity versions and
the judge, the decomposition and the qualifier inside the verdict sentence, the placebo, nudge and static-prompt rows,
and the programme stop. The anchor gate is not a guard against this: it shows that the instrument responds, not that it
is neutral.

**Simulator assumptions and rows (design D.10).** The planning model is the no-model simulator above ("Ceiling and
sensitivity"): the run's briefs, design, budget, capacity, memory rule and exam; a simulated agent that states each
planned fact with probability `compliance` (0.6; the anchor 0.8) and fills the budget at random from the brief;
simulated readings for the hook proxy. Its values are planning values, not predictions: the compliance and the agent's
fill are guesses about LLM behaviour, and the plans rely on the product's graph being the true one.

| policy (simulator, A-full, compliance 0.6) | what it does | AUC d/sd vs off | AUC points |
|---|---|---|---|
| anchor | true-state fact list, 2 prerequisites | 0.92 | +3.48 |
| shipped-default proxy | ≤ 2 unmet prerequisites within 2 hops, then the brief | 0.91 | +3.66 |
| static prerequisite-first prompt, same plan shape | the shipped-default proxy's plan with no readings ever | 1.04 (114% of the hook proxy) | +3.98 |
| candidate config proxy | 1 direct prerequisite, then the brief | 0.61 | +2.19 |
| one-fact static nudge | one fact of a random direct prerequisite first, no readings (a smaller plan, not like for like) | 0.41 | +1.38 |
| placebo | one fact of a random non-prerequisite off-brief concept | 0.12 | +0.38 |

In the planning model, a static prerequisite-first prompt does at least as well as the hook. The readings add nothing in
this model.

**What a positive result would prove, and what it would not.** It would prove that the shipped hook changed what an LLM
agent teaches, in a way that this fixed memory model rewards; in the simulator about 83-89% of that effect is carried by
the prerequisite rule. It would not prove that the gain comes from Learner's mastery readings: no arm isolates them, and
in the planning model a static prerequisite-first prompt does at least as well as the hook (d/sd 1.04 against 0.91).
Nor would it prove that real people or an LLM learner understand more, or that the app reports improvement accurately.

**The programme stopping rule.** Revision 10's main batch is the last confirmatory test of this configuration (the
shipped default) in this testbed, whatever the in-batch anchor check says. Every later confirmatory batch, under any
name, prints every earlier confirmatory verdict and the number of hook configurations tested, spends its alpha from the
programme's remaining 0.025, and builds its iteration log by query. No result is re-analysed under another estimand
after unblinding.

### Pre-registration (`SIM_PREREGISTRATION`, learning-sim-analysis.ts; revision 9 where it differs from revision 10)

**What the hook runs (revision 9).** Arm `on` runs Learner's shipped policy with `spacedRepetition: true` and
`foundationFirst: true`. Neither is the product default (both default to off), so the result is about the hook with
both on, conditional on the memory rules, and says nothing about the product as shipped or about a real person.

**Frozen before any data.** The run's record is in the database (revision 8.5, review 10 B1, S2): every learner's
config in `learning_sim_learners`, written with the learner before its first call, carries the run's commit, call cap
(`maxCalls`), k, `sequential`, arms, lanes, per-arm counts and looks, beside the learner's own sessions, turns,
models, holdout and task order. The pin step compares every stored learner with the run's input, record
included (a different `--max-calls`, `--turns` or anything else fails the run); a resume reuses the stored input.
Looks taken are rows of `learning_sim_looks` keyed by (run, look). No file is read. A real run's `--max-calls` is at
most 6,600 (`hardCallCap`), and the report's cost section prints the cap of record. The frozen tree
(`SIM_FROZEN_PATHS`, learning-sim-run.ts) is all of `packages/`, the root `package.json` and `bun.lock`, and this spec:
the sim, and the product code the run executes (the hook policy, the assessment workflow and grader) and that the
analysis recomputes claim 2 with (mastery changes, counted measurements, notifications). The start, the pin step,
every look and the report compare it with the recorded commit; any difference, committed or not, any untracked file
in it, or an unknown commit refuses the start or the run and fails the "frozen code and spec" check, which withholds
the verdict. So the run is made, recovered and analysed by a sim worker in a worktree pinned at that commit (see
Running it), never from a checkout that moves. Only the report step's report carries a verdict.

- **Primary:** whole-exam gain, `on` minus `off`, in the fast lane. It is the mean over the primary lanes (those with
  arm `on`: fast only) of the per-lane difference of complete-case means, each arm resampled within its lane (4,000
  draws), with 95% and 90% intervals.
- **Smallest effect of interest:** 2 points.
- **Scope:** the whole exam, all 13 concepts (see the ceiling's reading for why no narrower scope is neutral). The
  primary split into the 9 briefed concepts and the 4 foundations is reported with no verdict, as where an effect
  comes from, never as its sign. A primary carried by the foundations with the briefed split ≤ 0 is read as "budget
  moved to concepts the memory rules do not penalize" (foundations have no prerequisites, so they are always absorbed
  in full), not as "the readings help". `on` − `blind` (exploratory) separates the readings from the steering.
- **Lanes.** Main batch: fast lane `off` 30, `on` 30, `oracle` 4 (an anchor, no verdict); slow and medium `off` 2
  each (descriptive only). 30 per arm is a multiple of 10, so the Williams carryover balance is exact. Which lane can
  show an effect at 30 per arm (MDE = 0.74 SD, below), taking the no-model oracle gain as the effect to detect:

  | lane | oracle − off | omniscient − off | SD at which 30/arm detects the oracle gain | no-model SD | can it show an effect? |
  |---|---|---|---|---|---|
  | slow | +2.6 | +5.4 | ≤ 3.5 | 2.1 | **No.** The SD it needs is under twice a perfect note taker's (batch 1's real learners ran several times their floor). Dropped: arm off only. |
  | medium | +4.8 | +10.3 | ≤ 6.5 | 3.7 | **Only at a low SD, and not affordable.** Adding `on` 30 and 28 more `off` there costs about 5,100 calls (120.4 and 53.4 per learner), beyond the 6,600 cap. Dropped: arm off only. |
  | fast | +9.4 | +17.3 | ≤ 12.7 | 5.7 | **Only if the pilot's SD is ≤ 12.1** (the gate stays at revision 8's value; tighten only), and +9.4 is a ceiling heuristic's gain, not the shipped policy's. The primary. |

  (Revision 9 exam, 60 items. Revision 8's 64 items read +2.7 / +4.3 / +8.9, SD ≤ 3.7 / 5.8 / 12.1, fast floor 5.4. On the 104-item exam the three rows read +1.1 / +2.8 / +5.0, SD ≤ 1.5 / 3.8 / 6.8, floor
  1.0 / 1.5 / 2.9. The allocation is unchanged: every gain and every SD scaled up together.)
- **Power (stated before any model call).** MDE (80%, two-sided alpha 0.05, 30 per arm, t with 58 df) =
  2.85 × SD × √(2/30) = 0.74 SD of the per-learner whole-exam gain. The percentile bootstrap runs about 2% narrow at
  n = 30.

  | SD | 3 | 5 | 8 | 10 | 12.1 |
  |---|---|---|---|---|---|
  | MDE | 2.2 | 3.7 | 5.9 | 7.4 | 8.9 |
  | power at a true +4.5 | >99% | 93% | 57% | 40% | about 30% |

  (Power simulated: pooled-variance t test, 30 per arm, 20,000 draws per cell; it reproduces the revision-7 table's
  49% and 29% at +2.5 within 2 points.) The SD is unknown until the pilot. The no-model floor (perfect note taker,
  fast) is 5.7 on the revision-9 exam (5.4 on revision 8's; 2.9 on the 104-item exam, where batch 1 implied about 10; with fewer items
  each worth more, the real SD should scale up by about the same factor, 1.9).
  - **Not powered for the smallest effect of interest:** 2 points needs SD ≤ 2.7, below the no-model floor of 5.7.
    The smallest effect of interest stays 2 (it is a statement about learning, not about this exam), so on this exam
    it is out of reach.
  - **+9.4 is the gain of a ceiling heuristic** (prerequisites first, a sheet at a time), not of the shipped policy.
    A realistic effect may be half that, and at +4.5 the power is 93% at SD 5 and 57% at SD 8.
  - **"No effect of 2 points or more" is practically unreachable.** At a true 0 it is reached 80% of the time only at
    SD ≤ 2.65, under half the no-model floor of 5.7 (65% at SD 3, 23% at 4, 0% at 4.7). A null result will read "inconclusive"
    and says only that the effect is not above the realized MDE; it does not count against the product.
  - **Powering 2 points** needs 3.92 × SD² learners per arm (98 at SD 5), about 3 times the cap. That is the smallest
    change that would power it (no memory parameter, K or session count is changed to make an effect visible). It is
    the operator's decision and is not taken here.
- **Stopping rule (revision 8: group-sequential, the owner's decision; "Sequential design" below).**
  - The main batch is scheduled in three randomized blocks of 10 matched pairs (fast lane, arms `on` and `off`); block
    1 also carries the oracle, slow, medium and never-learns learners. When every learner of a block has ended, the
    runner takes the efficacy look by code; only "continue" starts the next block.
  - It stops at the first look that crosses the efficacy boundary or the futility rule, after the third look, at the
    call cap (the rest are incomplete: complete pairs only, incompletion reported, the verdict withheld if
    unbalanced), or not at all when a pilot gate failed. A look at which a pre-registered check fails or cannot be
    computed stops the batch with the verdict withheld.
  - The analysis computes the outcome and claim 2 only once the sequence has stopped; a run with fewer pairs than the
    first look is a pilot and its report holds mechanism, checks and gates only.
  - It never starts if a pilot gate failed, and always starts, as pre-registered, if every gate passed. Its cap is
    still computed from the full 3-block allocation (about 5,950 call keys; ≤ 6,600).
  - A killed or restarted sim worker is not a stop: it recovers the experiment run and resumes the open block without
    re-running ended learners.
  - **Noise gate**, from the pilot only: if the pooled within-arm SD of the fast lane's whole-exam gain (arms on and
    off) is above 12.1 (an MDE above revision 8's fast oracle gain, +8.9; it was 6.8 and +5.0 on the 104-item exam,
    and it scales because it is derived from that gain; revision 9's +9.4 would give 12.7, and the gate is not
    loosened), there is no main batch; a further batch is a new pre-registration.
    With 3 per arm (4 df) the gate is weak both ways: at a true SD of 17.8 it lets the batch run 24% of the time, and at
    a true SD of 12.2 it stops it 42% of the time.
  - No learner is added after any outcome is seen, and no efficacy look is taken at a pair count other than 10, 20
    or 30.
- **Verdict:** one of four, on the paired test (revision 8).
  - "supported": the paired t crosses the efficacy boundary at a look.
  - "harm shown": at the stop, the 95% paired t interval lies below 0.
  - "no effect of 2 points or more": at the stop, the 90% interval lies within ±2 (two one-sided tests at 5%).
  - "inconclusive": anything else ("inconclusive (stopped for futility)" after a futility stop).
  - Never softened.
- **Withheld** when any pre-registered check fails or cannot be computed. The unbudgeted and incompletion checks read the primary
  cells only (arms `on` and `off` in the primary lanes); oracle, blind, slow and medium are reported there, never
  gated, so 4-9 learners outside the estimand cannot withhold it. Held-out targeting and the frozen check cover the
  whole run: each detects a defect in the code or the record, not a property of the learners. The checks:
  - supported on delivered facts too (revision 8, re-review 5 point 1): when the primary reads "supported", the same
    contrast scored on the facts the channel delivered (the sensitivity series) must have its 95% lower end above 0,
    so knowledge that bypassed the channel cannot carry the verdict; otherwise the verdict is withheld. The report
    also gives unbudgeted facts per learner on − off with its interval (reported, not gated; the level limit below is
    unchanged);
  - unbudgeted knowledge about 0 and balanced (revision 9; `unbudgetedGuard`, `UNBUDGETED_GUARD`): on the final exam,
    each learner's count of facts scored 2 (not a declared guess) that the channel never delivered within budget. Over
    the matched pairs whose final exams both exist, at every look (10, 20, 30 pairs):
    - *balanced*: the exact two-sided sign-flip test of the within-pair differences (on − off) has p > 0.035 (each
      nonzero difference's sign is a fair coin under balance; p is enumerated over all sign patterns);
    - *about 0*: in each arm the one-sided 95% t lower bound of the mean count per learner is at most 0.5, so the
      limit tightens as pairs accrue (with Poisson-like spread, SD ≈ √mean, the largest passing mean is about 1.1 at
      10 pairs, 0.85 at 20 and 0.77 at 30: looser than revision 8's 0.5, the price of not withholding on noise);
    - fewer than 2 pairs: not computable (withheld).
    Its input is the counts only, never a score, a gain or the primary. It replaces revision 8's rule (both averages
    ≤ 0.5, within 0.2), which withheld balanced runs by noise alone (Pilot and cost, "Revision 9"). It counts facts,
    not points. The channel's lexical matcher stops 12 of the 18 loose paraphrases of scored facts
    (15 of 24 over the 104 items; 13 before revision 7 stopped counting placeholders such as `<name>` as content; the
    reviewer's harsher set: 2 of 14 scored, 2 of 15 in revision 8, 4 of 24 before); a tighter rule flagged 10-37% more of batch 1's agent sentences, mostly task talk, so the bound
    is placed here, on the outcome, instead;
  - incompletion balanced: within each primary lane, incomplete learners in `on` and `off` differ by at most 1;
  - no injection targets a held-out concept;
  - frozen code and spec (the whole `packages/` tree, root manifests and spec, above) against the commit of record,
    every learner in the database carrying the same run record, and (a real run) its looks the pre-registered ones.
- **Descriptive, never gated:** arm off's final exam by lane (the lane order), arm off's within-learner contrast, the
  unbudgeted rate of every arm and lane, and the exam scorer's agreement on double-scored exams.
- **Sensitivity (no verdict):** the primary with the final exam scored on the facts the channel delivered to that
  learner only, so knowledge that bypassed the channel cannot carry the difference.
- **Secondary, exploratory:** oracle minus off, oracle minus on, on minus blind, the within-learner contrast, and every
  contrast per lane. None carries a verdict and none is corrected for multiplicity.
- **Mechanism checks, reported before the outcome,** all from the matcher:
  - dose on targeted against untargeted concept-sessions (arm off is read on the concepts arm on targeted for
    learners with the same lane and Williams row);
  - delivered facts already right;
  - last-exam misses delivered;
  - redactions;
  - the memory rules' activity (forgotten, strengthened, not absorbed).

**Claim 2 has two pre-registered parts, each with a numeric pass/fail.** Both are computed only for a main-sized run.

1. **Does the app report improvement accurately? (`SIM_PREREGISTRATION.claim2.changes`)** What the app reports as
   improvement is masteryChanges (each concept's first-to-last change on the prior-blind series, with a 95% interval)
   and its gain notifications. They are read for arm `on` in the primary lane (the only arm that grades) against the
   simulator's truth, the exam's change over the same sessions. "accurate" needs all three; any one failed at its
   minimum n reads "inaccurate"; otherwise "not computable".

   | criterion | pass | min n | why this threshold |
   |---|---|---|---|
   | sign agreement where the exam moved 25+ points (two facts on the 104-item exam; one or two on the 64-item exam, whose concepts hold 2 to 6 items; the threshold is kept as stated) and the app reported a change | ≥ 75% | 20 | Chance is 50%. At n = 20, 15/20 has a 95% Wilson lower bound above 0.5, and a learner told "improved" should be right 3 times in 4 on clear moves. |
   | true change inside the app's 95% interval | ≥ 85% | 20 | Nominal 95, minus 10. Exam and reading scales differ, so this tests whether the stated uncertainty is honest on the exam's scale. |
   | false gain notifications (the exam did not rise between the reading it beat and this one); undecidable ones excluded | ≤ 20% | 10 | At most 1 "you improved" in 5 is false. |

2. **Grader level on blind probes (B6).** At the start of every session from the second, before the first turn, Sam
   is asked one content-free question about a concept whose facts the channel delivered in an earlier session (a
   draw keyed by run, learner and session), and answers from its notebook alone. The answer is a receipt, never a
   message, so the session never sees it. After the learner's last session each answer is graded by the product
   workflow under its own grading user, so no probe reading reaches an injection or the learner's own statistics, and
   with no earlier reading it is prior-blind. Truth is the exam after the previous session for that concept, which
   answered from the same notebook text. Every arm takes the probes. Reported: mean absolute error, bias and Spearman
   correlation, with 95% intervals resampling learners. Reading: accurate if MAE ≤ 20, MAE below that of a constant
   reading at the observed median truth (the constant with the least MAE), and the Spearman interval above 0; inaccurate if MAE ≥ 30, or with 40 or more
   pairs the interval covers 0; otherwise inconclusive. "Accurate" here means the grader reads the level of a
   notebook-derived answer well; it says nothing about change, which part 1 tests.

**Claim 2, exploratory (no verdict).** Gradings and those with an estimate, by prompt revision; each prior-blind
measurement against the exam after its session (Pearson r, bias, mean absolute error, a calibration table by
reading bin); the change correlation; verdicts beyond noise against whether the exam moved; each learner's aggregate
interval against its mean true change. Cost: calls, tokens and model time per role and session.

### Sequential design (revision 8, the owner's decision)

Code: `learning-sim-sequential.ts` (boundaries, paired t, looks), `simPairs` and `analyzeSimRun` (`looks`,
`endedPairs`), `learning-sim-health.ts` (health looks), `learning-sim-run.ts` (blocks, looks and the report as workflow steps);
tests in `learning-sim-sequential.test.ts` and `learning-sim-rules.test.ts` ("revision 8: interim looks …", "revision 8:
the health look is arm-blind …").

- **Matched pairs.** The k-th `on` and `off` learners of the fast lane are a pair (`config.pair` = `simSlots`
  cellIndex): the same holdout block and Williams row, and the memory rules' draws (forgetting, prerequisite
  absorption) keyed by run, lane and pair instead of by learner. The primary is the mean over primary lanes of the mean
  paired difference in whole-exam gain, complete pairs only; its interval is the paired t interval (df = pairs −
  lanes) at the stopping look, not adjusted for stopping (an early efficacy stop overstates the size; the table under
  "Bias at a stop" is printed beside it). The
  delivered-only check uses the same pairs. Within-pair correlation: 0.16 on the no-model simulator on the revision-9
  exam (0.24 on revision 8's, fast lane; SD of the difference 6.8 against 7.8 unmatched there); the LLM learner's own sampling dilutes it, to about 0.1 at SD 8 and near
  0 at the void batch's scale. The void runs have no pairs, so they cannot estimate it. At 0 correlation pairing costs
  about 1 point of power at n = 30 (29 df instead of 58); it never costs validity.
- **Efficacy looks: O'Brien–Fleming type**, one-sided overall α = 0.025, looks at 10, 20 and 30 pairs: critical z
  3.471, 2.454, 2.004 (nominal one-sided p 0.00026, 0.0071, 0.0225), applied to the paired t. Why not Pocock (2.289 at
  every look): OBF keeps the last look near the fixed test (2.004 against 1.96), so a moderate effect loses almost no
  power, and an early "supported" needs a large, clear effect rather than 10 noisy pairs.
- **Futility (binding, by code):** at look 1 or 2, a paired t ≤ 0 (or not computable) stops the batch. At a true +4.5
  it stops 2.4% of runs at SD 5 and 11.8% at SD 8; the power figures below include it. Expected: almost every futility
  stop reads "inconclusive (stopped for futility)". The "no effect of 2 points" reading needs a 90% interval within
  ±2 on 10 or 20 pairs, which at a true 0 happens about 1% of the time at SD 5 and practically never at SD 8.
- **Bias at a stop** (review 7 S4; the reviewer's simulation, 400,000 draws; `sequential.stopBias`, printed in the
  report beside a stopped primary). The mean estimate given a "supported" stop:

| truth, SD | overall | at a look-1 stop | at a look-2 stop | naive 95% coverage |
|---|---|---|---|---|
| +4.5, SD 8 | 6.4 | 11.8 | 7.7 | 93.2% |
| +4.5, SD 5 | 5.0 | 8.2 | 5.5 | 93.2% |
| 0 | 3.3 | 6.3 | 4.0 | 94.8% |

  The verdict carries the direction; the size from an early stop is read with this table, not as the effect.
- **False positives:** simulated at a true 0, 2.4% with futility and 2.6% without (100,000 draws); the suite re-checks
  it with a seeded 20,000-draw simulation (≤ 2.8%).
- **Power and calls** (20,000 draws each; about 174 calls per fast pair, plus 736 for the rest of block 1; full design
  about 5,950 call keys, cap ceil(K × (1.05 + r)) ≤ 6,600 unchanged):

| truth | SD | within-pair ρ | power | stops at look 1 / 2 / 3 (efficacy) | futility at 1 / 2 | expected pairs | expected calls |
|---|---|---|---|---|---|---|---|
| 0 | any | — | 2.4% (false positive) | — | 50% / 12.5% | 18.7 | ~3,970 |
| +4.5 | 5 | 0 | 90.5% (fixed paired 30: 92.2%) | 2.2% / 54.0% / 34.3% | 2.3% / 0.1% | 23.7 | ~4,850 |
| +4.5 | 5 | 0.24 (revision 8) | 96.2% | | | | ~4,630 |
| +4.5 | 5 | 0.16 (revision 9) | 94.6% (fixed paired 30: 95.4%) | | | 22.9 | ~4,716 |
| +4.5 | 8 | 0 | 53.2% (fixed: 56.1%) | 0.4% / 20.4% / 32.4% | 10.5% / 1.3% | | ~5,190 |
| +4.5 | 8 | 0.1 | 57.8% (fixed: 60.4%) | | | | |
| +8.9 | 5 | 0 | 100% | | | 17.6 | ~3,800 |
| +8.9 | 8 | 0 | 98% | | | | ~4,500 |
| +9.4 (revision 9's ceiling) | 5 | 0 | 100% | | | 17.1 | ~3,711 |
| +9.4 | 8 | 0 | 98.8% | | | | |

- **Two kinds of look, kept separate.**
  - *Health looks*: unlimited, from the first ended learner on: `sim-experiment.ts --run-id <id> --health`
    (read-only connection). Arm-blind or pooled only: learner statuses and failed ids, calls, pending calls, paid
    invocations, retried calls (a parse retry, or a grader validator repair) and 429s by role, call durations, the validity gates pooled (unbudgeted facts per
    learner, echo, the channel, the never-learns control) and per-item exam screening pooled over arms (items at full
    credit on ≥ 90% of final exams, items never at full credit, items the control got right). Ids and counts only, no
    learner text. It never computes or prints a between-arm outcome difference; the suite checks that swapping every
    `on`/`off` label leaves its output identical. Known and accepted: two health looks either side of one learner's
    completion difference to that learner's pooled numbers (its unbudgeted count, its item marks), and a failed id can
    be joined to its learner's config for its arm. Neither is a between-arm outcome: one learner, no comparison.
  - *Efficacy looks*: only at 10, 20 and 30 pairs whose learners have all ended, by the block workflow's look step
    (`takeSimLookStep`), after every learner of the block has completed. Until the sequence stops, the analysis
    returns no between-arm number (outcome, claim 2 and the per-arm exam-derived mechanism columns are withheld or
    pooled) and the look records the decision only.
  - *Durable looks* (revision 8.1, review 7 B2; in the database since revision 8.5). Each efficacy look is written
    once, when taken, as the row (run, look) of `learning_sim_looks` (insert-or-nothing) and is never re-taken or revised: a
    restart adopts the recorded looks and resumes at the first block without one, so a printed stop stays a stop. A
    look reads only the learners of the blocks it covers (never a later block's, which may be mid-run), and a block
    already looked at is never started again, so a learner counted incomplete at a look stays so.
  - *The report* is the run's last step, so it exists only once the recorded looks have stopped the sequence (or the
    last block ran): its between-arm numbers (dose, pooled denominators, per-arm noise and unbudgeted lines) come from
    pairs a look has read. `--report` prints nothing before (exit 6); read `--health` until then. It also checks that
    the recorded decisions are what the data give; a difference fails the frozen-code check and withholds the verdict.
  - `--sequential` is pinned in the run record and required for an allocation whose primary lane has ≥ 10 learners per
    arm, so a main batch cannot be started or resumed with every block at once.
- **The void rule.** If a health look finds a bug that changes the instrument (the exam, its scoring, the fact
  channel, the learner, the memory rules, the hook or the grader), the batch is void: the revision number goes up and
  data gathered before the fix is never pooled with data after it. In practice EVERY code fix ends the batch
  (review 7 S7): `SIM_FROZEN_PATHS` is all of `packages/`, the runner and the LLM service included, so a resume at any
  other commit is refused. That is deliberate. Telling an instrument change from a runner change is a judgment made
  after seeing the batch, the place where an exemption list would let a fix in under the wrong label; one rule that
  needs no judgment is cheaper than a mis-sorted fix. So a fix that does not change the instrument (the runner,
  scheduling, logging, the 429 handling) ends the batch too; only a fix that changes it raises the revision number.
  No data is ever pooled across commits, and the report says which kind each fix was.
- **Concurrency.** `--concurrency` (default 6, maximum 9) is the learners per wave; a learner makes one model call at
  a time, so it bounds the calls in flight. The sim worker's model-call slots (`LLM_CLI_MAX_CONCURRENT`) and workflow
  concurrency are 9. Before revision 8 the runner never set the slots, so every batch ran on the default 3. A
  429 (Too Many Requests) is never a learner outcome: it pauses every slot (backoff doubling from 30 s, capped at 5
  min, times a random 0.5–1.5), is not an attempt and not a paid invocation (it is counted as `rateLimited` on the
  receipt and in the health look; it never counts against `--max-calls`), and two 429s in a row drop the slots one
  step (not below 2; one burst of concurrent 429s drops one step, not one per 429), and 20 successes in a row take a
  step back up, never above 9. A step still rate-limited
  after 10 minutes fails as a capacity error; the workflow retries it, and the wave retries a failed learner (twice;
  then the run fails without taking the look, and `--resume` restarts it with its pinned input).
- **Wall time** (pilot throughput about 3 calls a minute per slot, scaling assumed linear and unverified above 3
  slots): the full design about 5.5 h at 6 slots and 3.7 h at 9; expected under a true 0 about 3.7 h at 6.

### Pilot and cost

**Revision 7: the first pilot is void.** Run 0946448d (2026-11-12, commit eccf81b, 9 learners, 617 paid invocations,
r = 0) failed two gates: unbudgeted knowledge (final exam, primary cells: `on` 12 facts, `off` 11, limit 1 each) and
learner echo (mean 0.52 and 21% at ≥ 0.7 on all 90 messages; 0.52 and 22.5% on the 80 length-matched; limits 0.35
and 5%). Noise (SD 3.65), valid ids (100%), readings, frozen code and cost passed. By the rule above it does not count,
and no main batch followed. Diagnosis (ids and counts only): of 26 unbudgeted final-exam facts over all arms, 20 were
claimed by the agent and stated in paraphrase the matcher missed, and the learner's notebook held them; the
others were stated unclaimed or follow from a delivered fact. The echo came from the turn after the agent's full
reply (above). The fixes are the claimed-fact rule and placeholder rule (channel), the questions-only view (B5), and
the echo gate's mean read on introduced words (a gate change, argued in B5 above). Nothing was tuned against an exam
outcome, and no estimand, lane, ceiling, power figure or threshold changed (the ceiling is a
no-model computation with a perfect note taker, untouched by either fix; neither fix adds a model call, so K and the
cap formula stand). The pilot reruns as below under a new run id, now with a hard cap. A new failure of either gate
again voids it. Revision 7 also adds the never-learns negative control (Arms, above), 2 learners in the pilot and 2 in
the main batch.

**Revision 8: the exam screen (owner decision: fix the instrument, not the gate).** The revision-7 probes showed the
unbudgeted gate would likely fail again for reasons outside the channel (Known limits). Revision 8 drops 40 of the
104 items (the list and the test are under "No exam answer outside the fact channel"). The list was fixed from the void
pilot and the two probes only, all void data, and is frozen with the tree; no item was chosen by arm or by an
outcome. Recomputed for the 64-item exam: the ceiling table, the lane table, the floor SD (5.4), MDE and power, and the
noise gate (12.1). Unchanged: the estimand, the arms, the allocation, the smallest effect of interest (2) and every
check's limit in facts. K and the cap stand, because the exam's call count is unchanged (one answer and one score per
exam): the pilot runs with `--max-calls 990` (ceil(942 × 1.05), r = 0), and the main batch's K of about 5,950 keeps its
cap ≤ 6,600 while r ≤ 0.058.

**Revision 9 (2026-11-14): a pre-launch amendment, before any main-batch data.** The rerun pilot df6e6374 passed
every gate. Its audit showed that revision 8's main-batch check on unbudgeted knowledge (both arms' final-exam means
≤ 0.5 per learner and within 0.2 of each other, at every look) would withhold the verdict by noise alone in about 21%
of runs at the pilot's primary-cell rate (0.17 facts per learner) and 50% at 0.33, mostly at look 1 (10 pairs, where
one fact more in one arm is already a gap of 0.1). Two changes, both decided before any main-batch learner exists and
from the pilot's arm-blind data only: no between-arm outcome was computed, and the pilot's unbudgeted counts were
read pooled over arms.
- **The rate.** All 7 unbudgeted incidences (6 items) over the pilot's 55 exams were reviewed by item id and the
  same-concept facts delivered before that exam, never by arm or score. 4 items are implied by a delivered fact and
  are dropped like revision 8's implied pairs (exam screen, above): rebraid-f8, slack-window-f4, ballast-check-f1,
  refit-f3. They account for 6 of the 7 incidences, including the one primary-cell fact (rebraid-f8, implied by the
  delivered rebraid-f2). mooring-f7 is kept. The exam has 60 items; recomputed on it (no model call): the ceiling
  table, the lane table, the floor SD (5.7), the fast within-pair correlation (0.16), and the sequential power. The
  noise gate stays 12.1 (the formula now gives 12.7; a gate is only ever tightened). Rescored on 60 items, the pilot's
  pooled fast SD is 6.04 and passes either value. Rescored, 2 of the 7 incidences remain, both on interim exams
  (mooring-f7, and ballast-check-f6, whose source fact refit-f3 the pilot delivered but is now off the sheets), and
  no final exam has an unbudgeted fact. Call keys are
  unchanged (one answer and one score per exam), so K and the cap stand.
- **The rule.** The fixed 0.2 gap is replaced by a paired guard (the check under Pre-registration): an exact sign-flip
  test of the on − off count differences over the matched pairs at a per-look α of 0.035, and per arm a one-sided 95%
  t lower bound of the mean count ≤ 0.5. Its input is the per-learner unbudgeted counts, as before; it never reads a
  score, a gain or the primary. It was chosen by simulation alone (a seeded script of pure arithmetic with no run data, kept with
  the revision 9 review packet): balanced arms at rates 0.05 to 0.33 per learner, Poisson and
  gamma-Poisson with dispersion k = 1, 0.5 and 0.25, the frailty independent or shared within a pair; looks at 10,
  20 and 30 cumulative pairs; a run is withheld if any look fails. The per-look α is the largest of 0.005, 0.01,
  0.0167, 0.025, 0.035 and 0.05 whose worst false-withhold rate over that grid stays ≤ 4% (1 point of Monte Carlo
  margin under the 5% target). The only input to the choice was those simulated arm-free rates; the pilot's counts
  set nothing but the range of rates simulated. Results, 40,000 runs per scenario:

  | scenario (on, off per learner) | revision 8 rule | revision 9 guard |
  |---|---|---|
  | balanced 0.17, Poisson (the pilot's rate) | 21.1% withheld | 1.9% |
  | balanced 0.33, Poisson | 49.6% | 3.4% |
  | balanced 0.33, k = 0.25 | 70.6% | 3.1% |
  | worst balanced case on the grid | 70.6% | 3.4% |
  | 3× imbalance, 0.33 vs 0.11, Poisson | 66.1% caught | 28.2% |
  | 3× imbalance, 0.33 vs 0.11, k = 1 | 65.6% | 21.8% |
  | 3× imbalance, 0.66 vs 0.22, Poisson (20,000 runs) | 96.5% | 63.6% |
  | 3× imbalance, 0.99 vs 0.33, Poisson | 99.9% | 93.3% |
  | 0.5 vs 0.1, Poisson | 94.6% | 70.6% |
  | shared leak 0.75 each, Poisson (20,000 runs) | 99.9% | 75.1% |
  | shared leak 1 each, Poisson | 100% | 99.2% |

  What this costs, stated plainly: at a 3× ratio near the pilot's rate (0.33 against 0.11) the guard catches the
  imbalance in only 28% of runs. The revision 8 rule's 66% there is not a usable alternative, since it withholds 50%
  of balanced runs at the same rate: it flags noise, not imbalance. At those rates the imbalance is about 0.2 facts per
  learner (about 0.4 exam points at the average item weight), and the delivered-only check (supported on delivered facts too) still has to pass
  for "supported". A shared leak moves no paired difference; the level bound catches 1 per learner in nearly every
  run and 0.75 in three of four.

The pilot comes before any main batch.
- **Size:** in fast, 3 `off` + 3 `on` + 1 `oracle`; in slow and medium, 1 `off` each; 2 never-learns controls
  (11 learners, about 940 planned calls). 3 per arm in fast gives the noise gate 4 degrees of freedom.
- **Its report holds no outcome and no claim 2** (below the main batch's 30 per arm), and the two exam-derived
  mechanism columns (delivered already right, last-exam misses delivered) are pooled over arms, since by arm they
  give each arm's interim exam level. The decision after the pilot is made without seeing the on − off contrast.
- **If every gate passes, the main batch runs as pre-registered.** It is not abandoned after a look at the pilot.
- **Gates.** A gate that cannot be computed fails.
  - unbudgeted knowledge, primary cells, as counts (3 learners per arm make a mean gap meaningless): on the final
    exam, each of `on` and `off` has at most floor(n / 2) unbudgeted facts in total (0.5 per learner), and the two
    totals differ by at most 1;
  - the noise gate (above);
  - learner echo of the agent (B5): the mean share of introduced words found in the agent's text ≤ 0.35 and at most 5%
    of messages with a plain overlap ≥ 0.7, on all messages and on those of 25-50 content words (revision 7, above);
  - valid claimed ids at least 95%;
  - every `on` learner is graded: the gate is not computable (it fails) unless every `on` learner has at least 2
    graded sessions; then, for every `on` learner, (a) every recorded grading of every graded session, main and
    replicates, has settled (completed, failed, no evidence or unchanged: any other recorded status fails, whatever its
    age, as does a reservation never recorded), and in a session that recorded any grading not all failed (revision
    8.5, review 10 S3: a session whose gradings were all skipped as unchanged or no evidence passes); and (b) from
    session 2 on, the session has at least one non-null reading. A failed grading settles, and the report prints, per
    learner and session, the gradings completed / failed / unchanged / no evidence / not settled (replicates and
    reservations included) and the concepts with a reading. A learner that fails after its last grading has every
    grading settled, so this gate passes it: only the incompletion check sees it. A session whose concepts were all skipped for no new evidence records no
    grading and passes (a). A lost grading is told apart because its reservation stays (status `reserved`), which
    fails (a). Revision 8.2 changed this gate after pilot db59766b, from arm-on grading receipts, no outcome, and before
    any outcome existed; revisions 8.3 and 8.4 made (a) and the session floor what they are now. The old
    gate (a non-null reading in every graded session, session 1 included) failed that pilot: in session 1 the learner
    has shown nothing citable yet, so the production grader correctly abstains (null, confidence insufficient), as it
    did for 13 of 15 session-1 gradings. Every one of those gradings completed with a receipt, and every arm-on learner
    had a non-null reading in sessions 2 to 4, so the new gate would have passed it.
  - the never-learns control (Arms, above): exam gain interval covers 0, and no notification or upward change;
  - the channel itself (revision 8, re-review 5 point 2; every learner and arm, the channel is arm-blind; `gates.channel`):
    in each agent turn's record, every claimed fact is budgeted, redacted as over budget, or already counted that
    session, and no over-budget fact that was not budgeted is found by the matcher in the text the learner read. Both
    counts must be 0. The unbudgeted gate above stays as it is; this one tests the channel, that one the exam floor.
- **The cap counts paid invocations,** not call keys: a parse retry, a capacity retry and a workflow step retry each
  count (`invocations` on the receipt, counted before the call is paid, so a call killed mid-flight counts), and a
  call in flight counts 1. A resumed step that adopts a killed child's answer counts again (an over-count, never
  an under-count). A grading counts as written under the cap above (main, replicates, validator repairs, takeovers). Concurrent steps other than gradings may overshoot by the calls in flight.
- **Cost (revision 9, superseded; revision 10's sizes, K and commands are in "Revision 10: the pre-registration of
  record" and the runbook below. Do not run these commands.)** (`--dry-run`, 5 sessions, 3 turns, k = 1; call keys, grader calls an upper bound; the totals move by a few
  calls with the run id, which draws the 10% of exams scored twice). Per learner: `off` about 53.4, `on` 120.4,
  `oracle` 68.6; the never-learns control about 120 (arm `on`).
  - Pilot: `--lanes none,slow,medium,fast --arms off,on,oracle --per-arm off=1,on=0,oracle=0 --per-arm-fast off=3,on=3,oracle=1 --per-arm-none off=0,on=2,oracle=0 --max-calls 990`,
    936-942 call keys (694-700 without the control). The cap is the main batch's formula on the pilot:
    ceil(942 × (1.05 + r)) with r = 0, the void pilot's measured retry share.
  - Main: the same with `--per-arm off=2,on=0,oracle=0 --per-arm-fast off=30,on=30,oracle=4 --per-arm-none off=0,on=2,oracle=0 --max-calls <the cap below>`,
    5,940-5,955 call keys (5,695-5,714 without the control). At r = 0 the cap is ceil(5,955 × 1.05) = 6,253; it stays
    ≤ 6,600 while r ≤ 0.058 (0.155 without the control). Its cap is pre-stated as `--max-calls` = ceil(K × (1.05 + r)): K the main allocation's
    planned call keys from `--dry-run`, r the pilot's retry share (paid invocations per call key minus 1, reservations
    excluded, printed in
    the pilot report's cost section), plus 5% margin. If that exceeds 6,600 the main batch does not run as
    pre-registered; a smaller allocation is a new pre-registration, chosen blind to the outcome the pilot withholds.

## Running it

Everything runs from a worktree pinned at the commit to record: the pin step refuses a real run whose frozen paths
differ from it, and the sim worker refuses stale codegen. `S` below is
`bun --env-file=/etc/learner/db.env packages/runtime-pikku/scripts/sim-experiment.ts`.

```bash
# 0. once per commit: a pinned worktree, its install and codegen
git -C /root/learner worktree add --detach /root/learner-lanes/sim-run-<id> <commit>
cd /root/learner-lanes/sim-run-<id> && bun install && (cd packages/runtime-pikku && bun run generate)

# 1. migrate learner_sim (created once: sudo -u postgres psql -c "CREATE DATABASE learner_sim OWNER learner").
#    The runtime never migrates it; this prints the migration names it applied, never the URL.
bun --env-file=/etc/learner/db.env packages/server/src/db/migrate.ts --sim

# 2. the sim worker: the only process that executes the runs. Supervised: a killed or failed worker restarts and
#    recovers every run it left (restart-safety rows 6, 8, 11); a second one waits for the fence.
systemd-run --unit=learner-sim-worker -p Restart=always -p RestartSec=30 -p WorkingDirectory=/root/learner-lanes/sim-run-<id> \
  bun --env-file=/etc/learner/db.env packages/runtime-pikku/src/bin/sim-worker.ts

# 3. the plan (opens no database: K by role), then the start. One operator, one start: a run id is started once.
#    Revision 10's pilot (K 1,495, cap 1,570); --after lists every revision-10 run before this one (none for the first):
P='--arms off,on,anchor --lanes fast,none --per-arm-fast off=12,on=3,anchor=12 --per-arm-none on=2,off=0,anchor=0'
$S --run-id <uuid> --dry-run $P
$S --run-id <uuid> $P --concurrency 6 --max-calls 1570 [--after <pilot 1's run id>]
#    the main batch (K 6,062, judge included), after a pilot that passed every gate:
M='--arms off,on,anchor --lanes fast,none --per-arm-fast off=36,on=36,anchor=10 --per-arm-none on=2,off=0,anchor=0 --sequential'
$S --run-id <uuid> $M --concurrency 6 --max-calls <ceil(6062 × (1.05 + r)) ≤ 6600> --after <every pilot's run id>

# 4. the health look, any time, read-only, arm-blind (ids and counts only; the experiment run's status first)
$S --run-id <uuid> --health

# 5. after a failure (a learner failed after its retries, a refusal fixed by a new pinned worktree): a new experiment
#    run with the same pinned input; it adopts every receipt and recorded look
$S --run-id <uuid> --resume

# 6. the final analysis: the report of record is the experiment run's last step; this prints it (exit 6 until the run
#    has completed; read --health until then)
$S --run-id <uuid> --report
```

Exit codes: 0 done; 6 no report yet; 7 refused (bad argument, a run id already started, a resume of a run that did
not fail, a dirty frozen tree, a database other than learner_sim). A start only enqueues the run; the worker's
refusals (the pin step) fail the experiment run, and `--health` shows it.

**Inputs of a real run** (revision 8.5, review 10 N3; revision 9: the durable experiment run). Every argv flag,
environment variable and file a real run reads. "Weaken" means: loosen a gate, raise or bypass the call cap, pass the
frozen-code check on other code, or change the pre-registered analysis. An input that could do one of these is pinned
in the run's input and in the database by the pin step, or refused outright. After the start, nothing from argv is
read: `--resume`, `--health` and `--report` take the run id alone.

| input | who controls it | what it feeds | why it cannot weaken anything |
|---|---|---|---|
| `--run-id` | operator | names the run: its learners, looks, ledger and experiment runs | a lowercase UUID or refused (exit 7). A start of an id already started is refused; the pin step refuses a second live or completed experiment run of it |
| `--arms`, `--lanes`, `--per-arm`, `--per-arm-fast`, `--per-arm-none`, `--sessions`, `--turns`, `--learner-model`, `--agent-model`, `--scorer-model`, `--grading-replicates`, `--sequential` | operator, at the start only | the design | validated by `simRunConfigs`, pinned in the run's input and in every learner's config (`config.run` and the learner's own fields) before its first call; a learner already stored with another config refuses the run. An allocation that reaches the first look without `--sequential` is refused |
| `--after` | operator, at the start only | the record's `run.after`: the revision-10 runs before this one | pinned in every learner's config; on learner_sim the pin step refuses unless the iteration-log query finds exactly these runs, then applies the iteration rule to their gates and the tree's changes since them (design C.6, R4). **Operator note:** that query counts every learner_sim run with an anchor or on learner created after revision 9's first learner, smoke runs included: each one consumes a pilot iteration, or blocks the next start until it is declared here. A run with only off learners is not counted |
| `--max-calls` | operator, at the start only | the hard call cap | required, at most 6,600 (`hardCallCap`) or refused, here and again by the pin step; pinned as `config.run.maxCalls`, which `assertSimCallBudget` reads before every paid invocation; a codex learner with no cap is never called |
| `--concurrency` | operator, at the start only | learners per wave (1 to 9) | pace only: no reading, gate or count depends on it. The worker's slots are fixed at 9 |
| `--resume` | operator | a new experiment run with the last failed one's input | reads the input from the database, never argv; refused unless the last experiment run failed or was cancelled |
| `--health`, `--report`, `--dry-run` | operator | the mode | `--health` and `--report` run read-only (`PGOPTIONS`) and only read; `--dry-run` opens no database |
| `DATABASE_URL` (`/etc/learner/db.env`) | operator (root) | server and credentials | the database name is overwritten to `learner_sim` (`sim-environment.ts`); every check reads `current_database()` |
| `PGOPTIONS` | (none) | session options | overwritten: read-only for `--health` and `--report`, deleted otherwise (review 10 N5) |
| `LEARNER_PIKKU_PGBOSS_SCHEMA`, `LEARNER_RUNTIME_DIRECTORY`, `LEARNER_WORKFLOW_CONCURRENCY`, `LLM_CLI_MAX_CONCURRENT`, `LEARNING_LOCAL_MVP_ENABLED` | (none) | queue schema, heartbeat directory, pace, the learning code path | set by `sim-environment.ts`: `learner_boss_sim`, `/run/learner/sim-runtime`, 9, 9, true |
| `LEARNING_*`, `LEARNER_SCHEDULES*`, `LEARNER_HINDSIGHT*`, `LEARNER_HABITS*`, `PG_BOSS_*`, `TEST_DATABASE*`, `LLM_*`, `LEARNER_ATTEMPT_*`, `LEARNER_UNLEASED_*`, `LEARNER_LLM_*`, `LEARNER_FAULT_*`, `LEARNER_GROWTHBOOK*`, `*_CLI_*`, `DISABLE_*`, `ENABLE_SCHEDULED_JOBS`, `LEARNER_ENV`, `APP_ENV` | (none) | product flags, retry and lease timing, the attempt directory, fault seams, CLI binaries and default models | deleted before any import: each takes its code default |
| `LEARNER_POOL_MAX`, `LEARNER_BOSS_POOL_MAX` | operator | connection pool sizes | pace only |
| `PATH`, `HOME`, `CODEX_HOME` | operator | which `codex` binary runs and its login | outside the frozen tree (a residual, like the provider's model). The cap is checked before every invocation and the gates and analysis read only receipts, so a binary cannot raise the cap, pass a gate or change the analysis |
| the checkout (git, `packages/runtime-pikku/.pikku`) | operator | the code the worker runs; the frozen-code check | the pin step refuses frozen paths that differ from the commit of record (git runs with no `GIT_*` variable); each look and the report check it again and fail integrity on a difference; the sim worker refuses codegen older than its sources |
| stub grader, stub transport, test looks (`simTest`) | tests only | the e2e | set only by `tests/sim-worker.fixture.ts`; the sim worker has no code path that sets them, and the pin step refuses test wiring or stub learners on learner_sim |
| `learning_sim_learners`, `learning_sim_calls`, `learning_sim_messages`, `learning_sim_looks`, the workflow tables (`learner_sim`) | the workflows | the record, the ledger, the looks, recovery | the record of reference, written only by the workflows' steps |

The suite's test (`simulated-learner.test.ts`) runs on its own database,
`learner_sim_test_<8 hex>` (`own-test-database.ts`: one per test run where the role may create it, as in
CI and the pre-push gate; otherwise the admin-created one per checkout; otherwise
the file is skipped). With a stub transport and stub grader model it runs a
batch (off in the slow, medium and fast lanes, on, and anchor) and checks the budget at the
channel, the calendar, that only `on` grades and each grading ran the product
workflow once with its replicate, that a second run of the same learners pays
for nothing, and the call cap; the two crash tests above; and the analysis on planted
fixtures with known estimates (revision 10: supported with replay identity, no effect with sensitivity
version (i) fired, incompletion withheld). The inconclusive and leaky cases, and every gate and look, are pinned by
`learning-sim-rules.test.ts` without a database.
`learning-sim-run.test.ts` checks both sides of `simRunRefusal` and the frozen-code check.
It proves the loop is wired and restart-safe, never an effect. `SIM_LIVE=true`
runs the batch on the real Codex transport.

## Batch 1 (superseded)

Batch 1 (e54225af, 45 learners, arms on/off/control/randomized/frozen) could
not answer claim 1 by design: the agent held every exam fact in every arm, so
injection changed neither what nor how much it taught, and the fixed catalog
holdout was confounded with three particular concepts. Its result (primary
+1.3, 95% [-2.8, 5.6], not shown) and its claim-2 findings are in its write-up.
Its design (agent manual with every fact, retests, leakage probe, the control,
randomized and frozen arms, the calibration runner) is deleted from the code;
re-scoring batch 1 runs from a checkout of that commit.

## Known limits

- Open wording contradiction in the shipped default (revision 10, P4, kept as shipped; `labelContradiction` in the
  pre-registration, printed in the report): when the teaching context shows `NO_READING_LINE`, it can still carry
  `PREREQUISITE_EXPERIMENT_LABEL` ("weakest lesson prerequisite in prompt"). Arm `on` tests the default as shipped,
  so the label is not changed during the freeze.
- Simulated learners are models: their "understanding" is what they write in
  a notebook and can retrieve under exam conditions.
- Evidence selection is term matching, not the product's retrieval.
- Gradings within a session run one after another (see the fan-out note above).
- **Unbudgeted knowledge that is not a channel leak (stated before the rerun pilot).** Two revision-7 probes, arm `off`,
  fast lane (28f58f3b: 1 learner, 5 sessions; c79a615f: 2 learners, 4 sessions) left 2 and 9 unbudgeted final-exam
  facts (2.0 and 4.5 per learner against the gate's 0.5). Of the 9, one was claimed and redacted at the channel; the
  rest are yes/no questions answered right without a declared guess (4 of 9) and facts that follow from a delivered
  fact or from material every arm sees (the brief, the manual, the exam's other questions). The gate's definition
  is unchanged. Revision 8 dropped those items from the exam instead (above), but only the implied pairs actually
  observed: a fact implied by another delivered fact in a pair not yet seen can still score as unbudgeted, and a
  failure on those grounds voids the pilot as before. A general implication table would be a new pre-registration.
  Revision 9 added the 4 pairs the rerun pilot showed (before any main-batch data); once a main batch has data, the
  list is frozen, and an implied pair seen there is reported, never dropped.
- **The unbudgeted guard trades sensitivity for not withholding on noise (revision 9).** Near the pilot's rate it
  catches a 3× between-arm imbalance in only about a quarter of runs (28% at 0.33 against 0.11 per learner), and its
  level bound lets a shared rate of 1 per learner pass look 1 (10 pairs) in about 4 runs in 10 (99% are caught by
  look 3). Both are bounded elsewhere: such an
  imbalance is about 0.4 exam points, a shared leak moves no paired difference, and "supported" must also hold on
  delivered facts only.
- **Residual dependence on guess declaration (after revision 8).** A declared guess scores 0 in every series (the
  primary, the unbudgeted count, the control's exam). In the void pilot learners declared 0 to 101 guesses of 104,
  and most of that variation sat on the yes/no items, which revision 8 dropped. What remains: an undeclared
  constructed answer (a code, a number, a name) that happens to be right scores 2 and counts as unbudgeted; one that
  is partly right can earn 1 point, which raises the primary and the control's exam but never the unbudgeted count
  (that counts 2s). Both are symmetric between arms by design. The control's exam measures their size directly;
  if it is not 0, the measured floor is reported and the gate's definition is the lead's decision, not changed here.

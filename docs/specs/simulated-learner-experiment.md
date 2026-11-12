# Simulated-learner experiment

Status: batch 1 (e54225af, design v1) finished and is written up; that design is
retired and its code deleted. Batch 2 runs on the design below, which is the only
one the code implements. Code: `packages/core/src/lib/learning/learning-sim-*.ts`
(curriculum, fact channel, memory rules, prompts, model calls, steps, analysis),
`packages/server/src/wirings/learning-sim-learner.workflow.ts` (the durable
workflows), `packages/server/src/functions/learning/learning-sim-experiment.function.ts`
(their steps), the framework runtime package's `scripts/sim-experiment.ts` (the runner),
`src/sim-learners.ts` (start or adopt a run's learners) and `tests/simulated-learner.test.ts`
(the suite's test, with the crash test), tables from migration 0027.

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
refit, squall), five incident briefs, a manual of concept names for the agent, a fact sheet of eight
atomic facts per concept and a 104-question exam (one question per fact, rubric 0/1/2). Fictional, so no
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

Each learner is one `learningSimLearnerWorkflow` run, started by the runner and
keyed by (run id, learner id): `startSimLearners` adopts a learner's run unless it
failed or was cancelled, so a batch is resumed by its run id alone. The levels
are Pikku workflows that start each other as child runs:

1. `learningSimLearnerWorkflow`: prepare (write the learner row, refuse a
   different config under the same ids, return the session plan), then one
   `learningSimSessionWorkflow` per session in order, then the summary.
2. `learningSimSessionWorkflow`: one step per action, in order: each learner
   turn and agent turn, the notebook, the exam answer and its scoring. Then, in
   arm `on` and every session but the last, one `learningSimGradeWorkflow` per
   concept, in order.
3. `learningSimGradeWorkflow`: prepare the assessment run (keyed by its request
   id `sim:<run>:<learner>:s<n>:<concept>`; nothing to grade when the concept has
   no evidence up to that session, or the same evidence as its last grading),
   then the product's `learningConceptAssessmentWorkflow` as a child run (plan
   replicates, grade, the policy's prior-blind replicates, combine, publish),
   skipped when that assessment already has a receipt, then record each
   grading, replicates included, as a counted call (`s<n>:grade:<concept>` and
   `...:r<k>`).

Fan-outs are sequential loops, never `Promise.all`: on `@pikku/core` 0.12.102 a
replay re-dispatches a sibling step that is still running, so a parallel fan-out
started each child run several times. Parallelism comes from running many
learners at once (`--concurrency`).

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
  its session, so a replay after later sessions grades what it graded first.

One process executes a sim database's runs: the runner (and the crash test's
worker) boots through `bootSimRunner`, which takes the worker's singleton fence
on that database (an advisory lock held by its own connection, so a killed
holder loses it at once), then recovers every run a dead executor left
`running`, then starts or adopts the learners' runs. A second runner is
refused (exit 2) and no process list is read, so a look-alike process (a
`tail` of the log, an editor) cannot stop recovery. With the fence held, a
step can only be orphaned by its holder dying, which the next holder recovers
at its boot; model calls carry their own lease (`driveAttempt`). A run whose
statuses and written rows do not change for `--stall-minutes` (30) ends the
runner with an `ALARM` line and exit 3; starting it again with the same
`--run-id` recovers. The crash test kills a worker
twice, on the shared crash harness: SIGKILL while a learner turn's CLI child
(the fake slow `codex`) is running, then SIGTERM inside a grading (product
workflow settled, rows not written), with a look-alike of the runner alive and
a second fence holder refused. The run completes with every call,
message, exam and grading exactly once, the killed call adopted from its
detached child (the CLI ran once; one `takeover` audit row), and no product
workflow started twice.

### No exam answer outside the fact channel

- **The agent's manual is concept names only.** `HALYARD_MANUAL` lists the 13 concepts and what each builds on.
  The batch-1 manual stated 85 of the 104 exam answers; this one states none.
- **The briefs state no answer.** The five incidents no longer quote error codes, metric names or defaults. For
  example, "draft from 64" became "draft limit to 512", and `LAPSED` became "pinned reads fail with an error".
- **A suite test checks every arm's base prompt.** The test covers the agent prompt with and without the hook's
  context, and the learner's prompt, for each of the five briefs. It fails when any window of two sentences gives an
  exam answer: at least 80% of the answer's content tokens (an error code in its own case), with the question's
  concept named. Eight answers are exempt because they are a concept's own name ("a tessel", "a rebraid"); an answer
  with a number is never exempt. Its positive control is the fact sheets themselves, which must fail it.

### The budget is enforced at the channel

- **Fact sheets are the only source of facts.** The agent sees the sheets of the concepts the brief or the learner's
  message names. It also sees up to 2 concepts it asked for on its previous turn (`lookups`).
- **Each session has a budget** of `round(capacity / 50)` facts: slow 2, medium 4, fast 8.
- **An arm-blind matcher reads every reply before the learner does** (`learning-sim-matcher.ts`). It knows nothing of
  the arm, the policy or the agent's claims.
  - A sentence, read with the one before it, states a fact in two cases: it holds at least 60% of the fact's content
    tokens with the fact's concept named, or 85% outright. It also states a fact when it gives that fact's exam answer
    with the concept named.
  - The matcher finds each of the 104 facts in its own text and nothing else.
  - A sentence that states an unoffered fact, or a fact past the session's budget, is replaced by `[…]`.
  - A fact already counted this session is free to repeat. A fact taught in an earlier session counts again.
  - What the matcher kept is what was taught (`statedFactIds`).
- **The agent's own list is measured, not trusted.** `statedFactIds` in the reply schema is an enum of the ids offered
  that turn. The agent's claims are kept as `claimedFactIds`. The report gives the share of valid ids and the share
  the matcher confirms.
- **Unbudgeted knowledge is the independent check.** It counts exam facts scored 2 (not a declared guess) that the
  channel never delivered within budget up to that exam. It is reported per session and by arm. This catches what the
  lexical matcher misses: a loose paraphrase reaches the learner unredacted and shows up here. It is pre-registered
  to be about 0 in every arm (at most 0.5 per learner-exam). If it is not, the verdict is withheld.

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

**Ceiling and sensitivity (no-model simulator, `learning-sim-ceiling.ts`, 40 learners per lane).** The simulator uses
the same briefs, Williams rows, holdout, budget, capacity and rules as a run. It has a perfect note taker and a perfect
exam. The policies:
- `off`: the brief's concepts, interleaved, in sheet order.
- `oracle`: the oracle arm's information, which is last exam's score per concept except the held-out ones. It takes
  missing prerequisites first, then the weakest named concept, skipping the share of each sheet the score says is
  known.
- `omniscient`: it reads the notebook and knows the rules.

Final exam, mean points:

| rules | lane | off (sd) | oracle | omniscient | oracle - off | omniscient - off | briefed 9: off (sd) | oracle - off |
|---|---|---|---|---|---|---|---|---|
| all rules | slow | 1.3 (1.0) | 2.4 | 5.0 | 1.1 | 3.8 | 1.6 (1.5) | -1.3 |
| all rules | medium | 4.8 (1.5) | 7.5 | 10.8 | 2.8 | 6.0 | 6.8 (2.2) | -4.4 |
| all rules | fast | 11.8 (2.9) | 16.8 | 24.4 | 5.0 | 12.6 | 16.6 (4.0) | -10.9 |
| forgetting off | slow | 2.5 (1.1) | 4.8 | 10.0 | 2.3 | 7.5 | 3.6 (1.7) | -2.5 |
| forgetting off | medium | 8.3 (2.1) | 11.8 | 20.0 | 3.4 | 11.7 | 11.9 (3.0) | -8.8 |
| forgetting off | fast | 17.1 (2.6) | 24.6 | 39.0 | 7.6 | 21.9 | 24.7 (4.1) | -17.8 |
| forgetting halved | slow | 1.8 (1.0) | 3.3 | 7.0 | 1.5 | 5.3 | 2.5 (1.5) | -1.9 |
| forgetting halved | medium | 6.2 (1.8) | 9.6 | 14.6 | 3.3 | 8.3 | 8.9 (2.5) | -6.3 |
| forgetting halved | fast | 13.9 (2.7) | 20.3 | 31.0 | 6.3 | 17.1 | 19.9 (4.1) | -13.6 |
| spacing off | slow | 1.3 (1.0) | 2.3 | 5.0 | 1.0 | 3.8 | 1.6 (1.5) | -1.3 |
| spacing off | medium | 4.7 (1.5) | 7.3 | 10.8 | 2.6 | 6.1 | 6.7 (2.1) | -4.3 |
| spacing off | fast | 11.7 (2.8) | 16.6 | 24.4 | 4.9 | 12.7 | 16.5 (4.0) | -10.7 |
| spacing halved | slow | 1.3 (1.0) | 2.3 | 5.0 | 1.0 | 3.8 | 1.6 (1.5) | -1.3 |
| spacing halved | medium | 4.8 (1.5) | 7.4 | 10.8 | 2.7 | 6.0 | 6.8 (2.2) | -4.4 |
| spacing halved | fast | 11.8 (2.9) | 16.7 | 24.4 | 4.9 | 12.7 | 16.6 (4.0) | -10.8 |
| prerequisites off | slow | 2.8 (0.9) | 2.6 | 5.6 | -0.2 | 2.8 | 4.0 (1.5) | -3.5 |
| prerequisites off | medium | 8.7 (1.5) | 7.6 | 12.0 | -1.1 | 3.3 | 12.3 (2.2) | -9.9 |
| prerequisites off | fast | 18.5 (2.2) | 16.9 | 25.6 | -1.6 | 7.1 | 26.9 (3.5) | -20.9 |
| prerequisites halved | slow | 2.1 (1.1) | 2.5 | 5.2 | 0.4 | 3.1 | 2.9 (1.7) | -2.4 |
| prerequisites halved | medium | 6.9 (1.7) | 7.6 | 11.3 | 0.7 | 4.4 | 9.8 (2.4) | -7.4 |
| prerequisites halved | fast | 15.6 (2.5) | 16.9 | 24.9 | 1.3 | 9.3 | 22.3 (3.9) | -16.5 |
| graph perturbed | slow | 1.3 (1.0) | 2.0 | 5.3 | 0.8 | 4.1 | 1.6 (1.5) | -1.5 |
| graph perturbed | medium | 4.6 (1.9) | 6.0 | 11.5 | 1.4 | 6.9 | 6.7 (2.7) | -5.2 |
| graph perturbed | fast | 11.3 (3.2) | 13.2 | 25.4 | 1.9 | 14.1 | 16.1 (4.5) | -12.8 |

What the table says (recomputed after the simulator's PRNGs were merged into one, `seeded` in `learning-sim-memory.ts`;
the gaps moved by up to 0.4 points):
- **The oracle's whole advantage comes from the prerequisite rule.** With that rule off, oracle is no better than off
  (and worse in medium and fast). Halved, it is under 1.4 points.
- **It also depends on the product's graph being the true one.** `graph perturbed` keeps every rule but gives each
  edge a seeded random prerequisite in the world, while the oracle policy still plans by the product's graph. The
  oracle's gain over off falls to 0.8, 1.4 and 1.9 (from 1.1, 2.8 and 5.0). The ceiling is therefore a statement about
  a world whose prerequisites are the ones the product believes, and says nothing about one where they are not.
- **Spacing changes nothing at these budgets** (±0.2). No policy can afford to re-teach a held fact when every
  budgeted fact is needed for new material.
- **Forgetting lowers every level but barely changes the gaps.**
- **The absolute scale is set by the fact budget.** At 2, 4 and 8 facts per session over 5 sessions, no policy can
  deliver more than 9.6, 19.2 or 38.5 exam points; "forgetting off, omniscient" reaches that cap.
- **Why the oracle loses on the briefed concepts.** Scored on the 9 concepts some brief names (last two columns),
  oracle minus off is -1.3, -4.4 and -10.9. The ceiling's `off` teaches only concepts its brief names, so it scores
  0 on the 4 foundations (tessel, keel-key, rebraid, mooring). The oracle plans over the whole exam, and it puts most
  of its fixed budget there: in whole-exam points it scores 2.0 / 5.6 / 13.1 on foundations and 0.3 / 1.6 / 4.0 on the
  briefed 9, against off's 0 and 1.3 / 4.7 / 11.5. A briefed-only score keeps off's points and drops the oracle's.
  (Measured with learning-sim-ceiling.ts, 40 learners per lane. With the prerequisite rule off the oracle still
  scores about 13 on foundations in fast, because shorter facts win its ties. So the split comes from the whole-exam
  objective against a brief-bound policy, not from the prerequisite rule alone.)
- **The scope is the whole exam** (Primary analysis). It favours no arm by construction: every arm in a run has the
  same exam, catalog, manual (which names each concept's prerequisites), 2 lookups beyond the brief and budget, so
  points on the foundations are any arm's agent's choice. (The ceiling's `off` policy never looks a prerequisite
  up; a run's `off` agent may.) A briefed-only score would penalize whichever arm teaches prerequisites. The 9/4
  split is reported for every contrast, with no verdict.
- **What the briefed-9 result implies.** The oracle row is one heuristic's gain (prerequisites at 0 first, then the
  weakest named concept, a whole sheet at a time; in fast one foundation's 8 facts fill a session), not a bound. The
  omniscient policy beats off on the briefed 9 as well (2.3 / 6.4 / 17.0 against 1.3 / 4.7 / 11.5, whole-exam points),
  so the briefed scope is not out of reach for an informed policy; the oracle heuristic simply spends its budget
  elsewhere. Two consequences, both pre-registered: the primary scope stays the whole exam, and the briefed/foundation
  split of on − off is read as WHERE an effect comes from, never as its sign. An `on` arm that teaches foundations can
  show a negative briefed split and a positive whole-exam gain, as the oracle does here.
- **Slow and medium cannot show an effect at an affordable size.** The oracle gain is +1.1 (slow) and +2.8 (medium).
  At 30 per arm (MDE 0.74 SD) slow would need SD ≤ 1.5 and medium SD ≤ 3.8, and running `on` in medium too would
  take the main batch past the 6,000-call cap. Both run arm off only; the primary is fast (+5.0, needs SD ≤ 6.8). See
  "Lanes" under the pre-registration.
- **The real learner is a language model, not the perfect note taker.** It packs facts more densely, so its levels
  and gaps can differ. The pilot's oracle learners give a first reading of the real ceiling.

### Lanes

A lane is a notebook capacity (characters of new notes per session: slow 100,
medium 200, fast 400) and a forget rate (`MEMORY_RULES`). The model is told the
budget and lists its most important facts first; facts are kept whole, in
order, until the budget is spent, and the rest are recorded as over capacity
(never truncated). The budget is in characters because, given a count of facts,
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
- **`blind`**: the same hook and policy, but the assessment lookup returns nothing, so the injection carries no reading
  of the learner. on minus blind is the part due to the readings. It needs no grading.
- **`oracle`**: the same policy, but the live turn reads the learner's true exam score from the previous session.

The agent is free to ignore the injection in every arm.

### What each role sees (the validity argument)

| Role | Sees | Never sees |
|---|---|---|
| Learner (Sam), writing a message | its notebook, the task brief, its own earlier messages this session, the agent's latest reply only (B5) | the agent's earlier explanations, the manual, the fact sheets, the exam, the arm, Learner's injected text |
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
reasoning. Sam now sees only the agent's latest reply, is told not to
paraphrase it, and gets the same instruction on every turn after the first.
A pilot gate (`learnerEcho`) measures it: each Sam message's content-word
overlap with the previous 3 agent messages, mean ≤ 0.35 and share ≥ 0.7 ≤ 5%,
both on all messages and on the length-matched subset (25–50 content types).

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
receipt still answers and no new call starts.

Defaults: learner `gpt-5.6-luna` low, agent and scorer `gpt-5.6-luna` medium,
grader the product's default (`gpt-5.6-luna` xhigh).

### Isolation

- Writes happen only on `learner_sim` (the runner, derived from `DATABASE_URL`)
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

### Pre-registration (`SIM_PREREGISTRATION`, learning-sim-analysis.ts)

**What the hook runs.** Arm `on` runs Learner's shipped policy with `spacedRepetition: true` and
`foundationFirst: true`. Neither is the product default (both default to off), so the result is about the hook with
both on, conditional on the memory rules, and says nothing about the product as shipped or about a real person.

**Frozen before any data.** `config.json` is written once, before the first call. It holds the arms, lanes, per-arm
counts, sessions, turns, models, k, every learner's config, the pre-registration and the commit. The frozen tree
(`SIM_FROZEN_PATHS`, src/sim-learners.ts) is all of `packages/`, the root `package.json` and `bun.lock`, and this spec:
the sim, and the product code the run executes (the hook policy, the assessment workflow and grader) and that the
analysis recomputes claim 2 with (mastery changes, counted measurements, notifications). A start, a resume and
`--analyze-only` all compare it with the recorded commit; any difference, committed or not, any untracked file in it,
or an unknown commit refuses the start or resume and fails the "frozen code and spec" check, which withholds the
verdict. So the run is made, restarted and analysed from a worktree pinned at that commit (see Running it), never from
a checkout that moves. Only `--analyze-only`'s report carries a verdict.

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
  | slow | +1.1 | +3.8 | ≤ 1.5 | 1.0 | **No.** Below the smallest effect of interest (2), and the SD it needs is barely above a perfect note taker's. Dropped: arm off only. |
  | medium | +2.8 | +6.0 | ≤ 3.8 | 1.5 | **Only at a low SD, and not affordable.** Adding `on` 30 and 28 more `off` there costs about 5,100 calls (120.4 and 53.4 per learner), beyond the 6,000 cap. Dropped: arm off only. |
  | fast | +5.0 | +12.6 | ≤ 6.8 | 2.9 | **Only if the pilot's SD is ≤ 6.8**, and +5.0 is a ceiling heuristic's gain, not the shipped policy's. The primary. |
- **Power (stated before any model call).** MDE (80%, two-sided alpha 0.05, 30 per arm, t with 58 df) =
  2.85 × SD × √(2/30) = 0.74 SD of the per-learner whole-exam gain. The percentile bootstrap runs about 2% narrow at
  n = 30.

  | SD | 3 | 5 | 6.8 | 8 |
  |---|---|---|---|---|
  | MDE | 2.2 | 3.7 | 5.0 | 5.9 |
  | power at a true +2.5 | 90% | 49% | 29% | 23% |

  The SD is unknown until the pilot. The no-model floor (perfect note taker, fast) is 2.9; batch 1 implies about 10.
  - **Not powered for the smallest effect of interest:** 2 points needs SD ≤ 2.8.
  - **+5.0 is the gain of a ceiling heuristic** (prerequisites first, a sheet at a time), not of the shipped policy.
    A realistic effect may be half that, and at +2.5 the power is 49% at SD 5.
  - **"No effect of 2 points or more" is practically unreachable.** At a true 0 it is reached 80% of the time only at
    SD ≤ 2.65, below the no-model floor (65% at SD 3, 23% at 4, 0% at 4.7). A null result will read "inconclusive"
    and says only that the effect is not above the realized MDE; it does not count against the product.
  - **Powering 2 points** needs 3.92 × SD² learners per arm (98 at SD 5), about 3 times the cap. That is the smallest
    change that would power it (no memory parameter, K or session count is changed to make an effect visible). It is
    the operator's decision and is not taken here.
- **Stopping rule.**
  - Fixed size, no interim look at the outcome. The analysis computes the outcome and claim 2 only for a run with the
    main batch's 30 per arm in arms `on` and `off` (`mainPerArm`); a smaller run is a pilot and its report holds
    mechanism, checks and gates only.
  - The main batch runs once, to all 68 learners. It ends early only at the call cap: the remaining learners are then
    incomplete (complete-case, incompletion reported, the verdict withheld if unbalanced).
  - It never starts if a pilot gate failed, and always starts, as pre-registered, if every gate passed.
  - The stall alarm is not a stop: the runner is restarted with the same run id.
  - **Noise gate**, from the pilot only: if the pooled within-arm SD of the fast lane's whole-exam gain (arms on and
    off) is above 6.8 (an MDE above +5.0), there is no main batch; a further batch is a new pre-registration. With 3
    per arm (4 df) the gate is weak both ways: at a true SD of 10 it lets the batch run 24% of the time, and at a true
    SD of 6.9 it stops it 42% of the time.
  - No learner is added after any outcome is seen.
- **Verdict:** one of four.
  - "supported": the 95% interval lies above 0.
  - "harm shown": it lies below 0.
  - "no effect of 2 points or more": the 90% interval lies within ±2 (two one-sided tests at 5%).
  - "inconclusive": anything else.
  - Never softened.
- **Withheld** when any pre-registered check fails or cannot be computed. The unbudgeted and incompletion checks read the primary
  cells only (arms `on` and `off` in the primary lanes); oracle, blind, slow and medium are reported there, never
  gated, so 4-9 learners outside the estimand cannot withhold it. Held-out targeting and the frozen check cover the
  whole run: each detects a defect in the code or the record, not a property of the learners. The checks:
  - unbudgeted knowledge about 0 and balanced: on the final exam, facts scored 2 that the channel never delivered
    within budget average at most 0.5 per learner in `on` and in `off`, and the two averages differ by at most 0.2
    (about 0.2 exam points). The channel's lexical matcher stops 13 of 24 loose paraphrases (the reviewer's harsher
    set: 4 of 24); a tighter rule flagged 10-37% more of batch 1's agent sentences, mostly task talk, so the bound
    is placed here, on the outcome, instead;
  - incompletion balanced: within each primary lane, incomplete learners in `on` and `off` differ by at most 1;
  - no injection targets a held-out concept;
  - frozen code and spec (the whole `packages/` tree, root manifests and spec, above), and every learner in the
    database matching `config.json`.
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
   | sign agreement where the exam moved 25+ points (two facts) and the app reported a change | ≥ 75% | 20 | Chance is 50%. At n = 20, 15/20 has a 95% Wilson lower bound above 0.5, and a learner told "improved" should be right 3 times in 4 on clear moves. |
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

### Pilot and cost

The pilot comes before any main batch.
- **Size:** in fast, 3 `off` + 3 `on` + 1 `oracle`; in slow and medium, 1 `off` each (9 learners, about 700 planned
  calls). 3 per arm in fast gives the noise gate 4 degrees of freedom.
- **Its report holds no outcome and no claim 2** (below the main batch's 30 per arm), and the two exam-derived
  mechanism columns (delivered already right, last-exam misses delivered) are pooled over arms, since by arm they
  give each arm's interim exam level. The decision after the pilot is made without seeing the on − off contrast.
- **If every gate passes, the main batch runs as pre-registered.** It is not abandoned after a look at the pilot.
- **Gates.** A gate that cannot be computed fails.
  - unbudgeted knowledge, primary cells, as counts (3 learners per arm make a mean gap meaningless): on the final
    exam, each of `on` and `off` has at most floor(n / 2) unbudgeted facts in total (0.5 per learner), and the two
    totals differ by at most 1;
  - the noise gate (above);
  - learner echo of the agent (B5): mean overlap ≤ 0.35 and at most 5% of messages at ≥ 0.7, on all messages and on
    those of 25-50 content words;
  - valid claimed ids at least 95%;
  - every `on` learner has a non-null reading in every graded session (the report lists, per session, the concepts
    with a reading).
- **The cap counts paid invocations,** not call keys: a parse retry, a capacity retry and a workflow step retry each
  count (`invocations` on the receipt, counted before the call is paid, so a call killed mid-flight counts), and a
  call in flight counts 1. A resumed step that adopts a killed child's answer counts again (an over-count, never
  an under-count). Each grading replicate counts 1; the product grader's own internal retries are not counted. Concurrent steps may overshoot by the calls in flight.
- **Cost** (`--dry-run`, 5 sessions, 3 turns, k = 1; call keys, grader calls an upper bound; the totals move by a few
  calls with the run id, which draws the 10% of exams scored twice). Per learner: `off` about 53.4, `on` 120.4,
  `oracle` 68.6.
  - Pilot: `--lanes slow,medium,fast --arms off,on,oracle --per-arm off=1,on=0,oracle=0 --per-arm-fast off=3,on=3,oracle=1`,
    694-700 call keys.
  - Main: the same with `--per-arm off=2,on=0,oracle=0 --per-arm-fast off=30,on=30,oracle=4 --max-calls <the cap below>`,
    5,695-5,714 call keys. Its cap is pre-stated as `--max-calls` = ceil(K × (1.05 + r)): K the main allocation's
    planned call keys from `--dry-run`, r the pilot's retry share (paid invocations per call key minus 1, printed in
    the pilot report's cost section), plus 5% margin. If that exceeds 6,600 the main batch does not run as
    pre-registered; a smaller allocation is a new pre-registration, chosen blind to the outcome the pilot withholds.

## Running it

```bash
# plan only: the call count per role (grading is an upper bound)
bun --env-file=/etc/learner/db.env packages/runtime-p*/scripts/sim-experiment.ts --dry-run --per-arm 6 --lanes slow,medium,fast --sessions 5

# run from a worktree pinned at the commit to record; a start, resume or analysis anywhere else is refused
git -C /root/learner worktree add --detach /root/learner-lanes/sim-run-<id> <commit>   # then: bun install, codegen

# run (or resume, with the same --run-id); results in /var/lib/learner/sim/<runId>/
LLM_CLI_MAX_CONCURRENT=4 bun --env-file=/etc/learner/db.env packages/runtime-p*/scripts/sim-experiment.ts \
  --per-arm 1 --sessions 3 --concurrency 4

# the pilot and the main batch run supervised, so no step waits for a human (restart-safety rows 6, 8, 11):
# a killed runner, a stall (exit 3, after an ALARM line; --stall-minutes default 45, twice the longest healthy model
# step) or a failed learner (exit 1) is restarted with the same --run-id, and each boot takes the fence and recovers.
# Exit 2 (another runner holds the fence) and 4 (stale codegen) are not restarted. Three restarts in an hour leave
# the unit failed: the alarm that a restart did not heal.
systemd-run --unit=learner-sim-<id> -p Restart=on-failure -p RestartSec=30 -p RestartPreventExitStatus="2 4" \
  -p StartLimitIntervalSec=3600 -p StartLimitBurst=3 -p WorkingDirectory=/root/learner-lanes/sim-run-<id> -E LLM_CLI_MAX_CONCURRENT=4 \
  bun --env-file=/etc/learner/db.env packages/runtime-pikku/scripts/sim-experiment.ts --run-id <id> <the allocation above>

# who hears the alarm: this box has no notifier, so whoever starts the unit also starts this watch, and it ends with
# one line when the unit fails or stops; that person reports it to the operator (the lead, for the pilot).
until systemctl is-failed --quiet learner-sim-<id> || ! systemctl is-active --quiet learner-sim-<id>; do sleep 60; done; \
  systemctl status --no-pager learner-sim-<id> | head -5

# re-analyze a run (reads receipts only, no model call); only this report carries a verdict
bun --env-file=/etc/learner/db.env packages/runtime-p*/scripts/sim-experiment.ts --run-id <id> --analyze-only
```

`learner_sim` is created once:
`sudo -u postgres psql -c "CREATE DATABASE learner_sim OWNER learner"`, then
migrated with `migrateToLatest` on its URL.

The suite's test (`simulated-learner.test.ts`) runs on its own database,
`learner_sim_test_<8 hex>` (`own-test-database.ts`: one per test run where the role may create it, as in
CI and the pre-push gate; otherwise the admin-created one per checkout; otherwise
the file is skipped). With a stub transport and stub grader model it runs a
batch (off in three lanes, on, oracle and blind) and checks the budget at the
channel, the calendar, that only `on` grades and each grading ran the product
workflow once with its replicate, that a second run of the same learners pays
for nothing, and the call cap; the crash test above; and the analysis on planted
fixtures with known estimates (supported, no effect, inconclusive, withheld).
It proves the loop is wired and restart-safe, never an effect. `SIM_LIVE=true`
runs it on the real Codex transport.

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

- Simulated learners are models: their "understanding" is what they write in
  a notebook and can retrieve under exam conditions.
- Evidence selection is term matching, not the product's retrieval.
- Gradings within a session run one after another (see the fan-out note above).

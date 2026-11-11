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
   prior-blind and anchored measurement series, mastery changes, gain
   notifications) against the same exam.

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

A killed worker's runs are resumed by the recovery pass at boot (the worker's,
and the runner's when no other runner is alive). The crash test kills a worker
twice, on the shared crash harness: SIGKILL while a learner turn's CLI child
(the fake slow `codex`) is running, then SIGTERM inside a grading (product
workflow settled, rows not written). The run completes with every call,
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

| rules | lane | off (sd) | oracle | omniscient | oracle - off | omniscient - off |
|---|---|---|---|---|---|---|
| all rules | slow | 1.4 (0.9) | 2.7 | 4.6 | 1.4 | 3.3 |
| all rules | medium | 5.2 (1.7) | 7.5 | 10.3 | 2.4 | 5.1 |
| all rules | fast | 11.6 (2.6) | 16.9 | 24.0 | 5.3 | 12.4 |
| forgetting off | slow | 2.6 (1.1) | 4.8 | 10.0 | 2.1 | 7.4 |
| forgetting off | medium | 8.4 (2.0) | 11.5 | 20.0 | 3.1 | 11.6 |
| forgetting off | fast | 17.0 (2.7) | 24.0 | 39.0 | 7.0 | 22.0 |
| forgetting halved | slow | 1.9 (1.1) | 3.6 | 6.7 | 1.7 | 4.8 |
| forgetting halved | medium | 6.4 (1.8) | 9.2 | 14.3 | 2.8 | 7.9 |
| forgetting halved | fast | 14.0 (2.7) | 19.9 | 30.3 | 5.9 | 16.3 |
| spacing off | slow | 1.4 (0.9) | 2.6 | 4.6 | 1.3 | 3.3 |
| spacing off | medium | 5.0 (1.6) | 7.4 | 10.3 | 2.4 | 5.3 |
| spacing off | fast | 11.4 (2.6) | 16.6 | 24.0 | 5.2 | 12.6 |
| spacing halved | slow | 1.4 (0.9) | 2.7 | 4.6 | 1.4 | 3.3 |
| spacing halved | medium | 5.1 (1.6) | 7.5 | 10.3 | 2.4 | 5.2 |
| spacing halved | fast | 11.5 (2.6) | 16.8 | 24.0 | 5.3 | 12.5 |
| prerequisites off | slow | 2.7 (1.0) | 2.8 | 5.6 | 0.1 | 2.9 |
| prerequisites off | medium | 9.2 (1.7) | 7.5 | 11.6 | -1.7 | 2.4 |
| prerequisites off | fast | 19.1 (2.0) | 16.9 | 25.1 | -2.3 | 6.0 |
| prerequisites halved | slow | 2.0 (0.8) | 2.8 | 4.9 | 0.8 | 2.9 |
| prerequisites halved | medium | 7.3 (1.7) | 7.5 | 10.8 | 0.2 | 3.5 |
| prerequisites halved | fast | 15.8 (2.3) | 16.9 | 24.8 | 1.1 | 9.0 |

What the table says:
- **The oracle's whole advantage comes from the prerequisite rule.** With that rule off, oracle is no better than off
  (and worse in medium and fast). Halved, it is under 1.1 points.
- **Spacing changes nothing at these budgets** (±0.2). No policy can afford to re-teach a held fact when every
  budgeted fact is needed for new material.
- **Forgetting lowers every level but barely changes the gaps.**
- **The design cannot see an effect of the planned size.** The oracle ceiling over off, averaged over slow and medium,
  is +1.9 points, below the smallest effect of interest (2) and below the minimum detectable effect of the planned
  size (about 3.9 at 13 learners per arm per lane, from the reviewer's power calculation).
- **Pre-registered target: +1.0 point** (half the oracle ceiling, slow and medium). At that target the only reachable
  readings are "no effect of 2 points or more" (if the interval is narrow enough) or "inconclusive". The fast lane's
  oracle ceiling is +5.3. Including it is the operator's decision before any spend.
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

`config.json` is written once, before the first call. It holds the arms, lanes, per-arm counts, sessions, turns,
models, k, every learner's config, the commit, and the sha256 of the analysis, design, prompt, matcher and memory
modules. A resumed invocation that differs in any of these is refused. A run is refused if those modules have
uncommitted changes. `--analyze-only` verifies the record: the module hashes, and every stored learner config against
the database. Only its report carries a verdict.

- **Primary:** whole-exam gain, `on` minus `off`. It is the mean over the run's lanes of the per-lane difference of
  complete-case means, with each arm resampled within its lane (4,000 draws). It uses 95% and 90% intervals.
- **Smallest effect of interest:** 2 points.
- **Verdict:** one of four.
  - "supported": the 95% interval lies above 0.
  - "harm shown": it lies below 0.
  - "no effect of 2 points or more": the 90% interval lies within ±2 (two one-sided tests at 5%).
  - "inconclusive": anything else.
  - Never softened.
- **Withheld** when any pre-registered check fails or cannot be computed. The checks:
  - unbudgeted knowledge about 0 in every arm;
  - incompletion balanced (within a lane, incomplete learners per arm differ by at most 1);
  - no injection targets a held-out concept;
  - arm off's final exam rises with lane capacity;
  - config integrity.
- **No interim look.** The pilot reports mechanism and checks only. Incompletion is reported by arm and lane.
- **Secondary, exploratory:** oracle minus off, oracle minus on, on minus blind, the within-learner contrast, and every
  contrast per lane. None carries a verdict and none is corrected for multiplicity.
- **Mechanism checks, reported before the outcome,** all from the matcher:
  - dose on targeted against untargeted concept-sessions (arm off is read on the concepts arm on targeted for
    learners with the same lane and Williams row);
  - delivered facts already right;
  - last-exam misses delivered;
  - redactions;
  - the memory rules' activity (forgotten, strengthened, not absorbed).

**Claim 2, primary: blind probes (B6).** At the start of every session from
the second, before the first turn, Sam is asked one content-free question
about a concept whose facts the channel delivered in an earlier session (a
draw keyed by run, learner and session), and answers from its notebook alone.
The answer is a receipt, never a message, so the session never sees it. After
the learner's last session each answer is graded by the product workflow
under a separate grading user (so no probe reading reaches an injection or the
learner's own statistics; with no earlier reading it is prior-blind). Truth is
the exam after the previous session for that concept, which answered from the
same notebook text. Every arm takes the probes. Reported: mean absolute
error, bias and Spearman correlation, with 95% intervals resampling learners.
Reading: accurate if MAE ≤ 20 and the Spearman interval is above 0;
inaccurate if MAE ≥ 30, or with 40 or more pairs the interval covers 0;
otherwise inconclusive.

**Claim 2, in-conversation readings (EXPLORATORY, no verdict).** Only arm `on` grades. Reported:
gradings and those with an estimate, by prompt revision; gain notifications that
were false (the exam did not rise for that concept between the reading it beat
and this one); and for each of the prior-blind and anchored series: each
measurement against the exam after its session (Pearson r, bias, mean absolute
error, a calibration table by reading bin), each concept's first-to-last change
against the exam's change (correlation, sign agreement, interval coverage,
verdicts beyond noise against whether the exam moved), each learner's aggregate
interval against its mean true change, and the lanes ranked by reading against
the exam's ranking. Cost: calls, tokens and model time per role and session.

### Pilot and cost

The pilot comes before any main batch.
- **Size:** in slow and medium, 2 `off` + 2 `on` + 1 `oracle` per lane, plus 1 `off` in fast.
- **Gates.** A gate that cannot be computed fails.
  - unbudgeted knowledge about 0;
  - valid claimed ids at least 95%;
  - every `on` learner has a non-null reading in every graded session (the report lists, per session, the concepts
    with a reading);
  - arm off's lanes ordered.
- **Cost:** the runner's `--dry-run` prints the planned calls. The main batch's size is set from the pilot's SD and
  the ceiling above, within the operator's cap.

## Running it

```bash
# plan only: the call count per role (grading is an upper bound)
bun --env-file=/etc/learner/db.env packages/runtime-p*/scripts/sim-experiment.ts --dry-run --per-arm 6 --lanes slow,medium,fast --sessions 5

# run (or resume, with the same --run-id); results in /var/lib/learner/sim/<runId>/
LLM_CLI_MAX_CONCURRENT=4 bun --env-file=/etc/learner/db.env packages/runtime-p*/scripts/sim-experiment.ts \
  --per-arm 1 --sessions 3 --concurrency 4

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

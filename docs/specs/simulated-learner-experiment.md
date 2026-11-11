# Simulated-learner experiment

Status: harness, end-to-end test and pilot landed; the main run has NOT been
started. Code: `packages/core/src/lib/learning/learning-sim-*.ts` (curriculum,
prompts, model calls, steps, analysis),
`packages/server/src/wirings/learning-sim-learner.workflow.ts` (the durable
workflow), `packages/server/src/functions/learning/learning-sim-experiment.function.ts`
(its steps), the framework runtime package's `scripts/sim-experiment.ts` (the runner) and
`tests/simulated-learner.test.ts` (the suite's test),
tables from migration 0027.

## Questions

1. **Does Learner's knowledge injection improve understanding?** Compared with no
   Learner at all, with an agent that gets the same amount of irrelevant text,
   and within a learner, on taught concepts against held-out ones.
2. **Does Learner's reporting measure it accurately?** Its readings
   (`learning_mastery_readings`), mastery notifications and holdout split,
   compared with an independent closed-book exam.

Real users cannot answer either cleanly: nobody takes an exam, arms cannot be
assigned per person, and real conversations differ in more than the treatment.
Simulated learners can be assigned, examined and replayed. What they cannot do
is stand in for people: every result here is about Codex models playing a
learner, and says nothing direct about humans.

## Design

### The subject: a fictional curriculum

"Halyard", a fictional event-pipeline runtime (`learning-sim-halyard.ts`): 13
concepts with prerequisite edges (tessel, keel key, twin rule, overbear,
rebraid, slack window, beat, mooring, draft limit, becalming, ballast check,
refit, squall), five work sessions with task briefs, a reference manual for the
agent and a 104-question exam (8 single-fact questions per concept, rubric 0/1/2). Fictional, so no
model knows it in advance: everything a learner knows about it came from the
conversation. Baseline exams confirm it (0 at timepoint 0 in the pilot).

It is loaded through the real curriculum tables as a GENERATED curriculum
(owner `sim-halyard`), never a seed: the API's startup and the test preload
retire every seed not in the shipped library. The live hook path takes it
through a catalog seam (`LiveCatalog`: concepts + version): `beginLiveTurn` and
`submitLiveTurnFeedback` default to the shipped catalog, so the product path is
byte-identical, and the experiment passes Halyard's.

The holdout is the product's: `md5("osmosis-concept-holdout:<id>")` bucket 0 of
5. The concept-id prefix `halyard-core--` was chosen (among 20 candidates)
so that the split puts 3 concepts on 3 different branches into the held-out
group (mooring, ballast check, overbear), with mean graph depth equal to the
taught ones.

### One learner, one durable workflow

`learningSimLearnerWorkflow` runs one learner end to end on the queue workers:

1. Baseline exam (answers from an empty notebook, scored blind).
2. Per session (`--sessions`, up to 5) and turn (`--turns`):
   - **Learner** (Codex) writes Sam's next message from Sam's notebook, the task
     brief and the conversation so far.
   - **Agent** (Codex), in the Learner arms, goes through the hook's server path:
     `beginLiveTurn` (the human turn is stored), the agent's feedback JSON
     (concept tags with exact quotes, the hook's submission step), then
     `submitLiveTurnFeedback` under the arm's policy, exactly the functions the
     hook's RPCs call. The agent then replies with the hook's text and the
     returned guidance in its context.
   - After the last turn, the learner updates its **notebook**: short facts
     grouped by topic. The model returns only NEW facts, most important first,
     and code applies the lane's memory model (below). Nothing within the
     learner's capacity is ever cut; each session records facts added, facts
     over capacity and facts forgotten. The notebook is the learner's only
     memory between sessions.
     (Pilot 2 used a single text with a hard cap: 11 of 15 notebooks were cut,
     so learning could not accumulate. That design is retired.)
   - **Grading** by Learner, per concept: the product's
     `LearningConceptAssessmentService` (default model and prompt), on evidence
     selected by term matching over the learner's own turns and the agent reply
     after each (a stand-in for retrieval). A concept with no evidence, or with
     the same evidence as last time, is not regraded.
     In every Learner arm the grading runs the product's
     `learningConceptAssessmentWorkflow`, as a manual assessment does: plan
     replicates, grade, the policy's `gradingReplicates - 1` prior-blind
     replicates, combine, publish. The sim step starts that workflow (one per
     assessment run; a retried step waits on the one it started) and records
     each grading, replicates included, as a counted call
     (`s<n>:grade:<concept>` and `...:r<k>`). `off` grades directly, once.
     `--grading-replicates k` (default 1) sets k in learner_sim's policy before
     the run; a stub run installs the stub grader as the runtime's own, so it
     never reaches the paid grader through the workflow.
   - **Exam** after the session: answered from the notebook only, scored blind.
3. **Retest**: the grader's newest completed readings (`--retests`) regraded
   on identical evidence, as experiment runs that never replace the live
   estimate.
4. **Leakage probe**: three concepts, each with an assistant-only explanation
   and a learner who only acknowledges.
5. Summary.

The run is one ordered action list walked in a single flat loop, one step per
action. The framework's DSL takes neither nested loops nor a branch inside a
loop, and its inspector does not register the steps of an inner loop. Each
step is one model call or one grading (k gradings through the workflow, run
in sequence), so it stays inside pg-boss's 15-minute job expiry. A grading
step holds its queue slot while it waits, so the runner raises
`LEARNER_WORKFLOW_CONCURRENCY` to at least twice the learner concurrency.

### The exam (8 facts per concept)

Every concept has a sheet of eight atomic facts (`learning-sim-facts.ts`), each
tested by one question with a 0/1/2 rubric: 104 questions in all. The sheets
extend the curriculum text and are appended to the agent's manual, so the agent
can teach anything the exam asks. The curriculum's own three questions per
concept were answered in full from two remembered facts, so the exam saturated
(calibrations 916dea5f and 9fbdbad2); eight facts per concept leave headroom
that only repeated teaching fills.

### Learner ids and the call cap

A learner's id is fixed by (lane, arm, index): `l<lane 1-3><arm 0-4><index>`,
so a smoke run is the first learners of the batch under the same run id. The
runner's `--max-calls` is a hard cap on the run's model calls of every role,
the grader's included (retests and leakage probes are counted too): no new
call starts once the run has stored that many.

### What each role sees (the validity argument)

| Role | Sees | Never sees |
|---|---|---|
| Learner (Sam) | its notebook, the task brief, this session's conversation | the manual, the exam, the arm, Learner's injected text |
| Agent | the Halyard manual (every arm, as an agent knows a real tool), the brief, the conversation; Learner arms: the hook text + guidance; control: irrelevant text of the same length | the exam, the notebook |
| Exam scorer | questions, rubric, answers | arm, notebook, conversation |
| Learner's grader | the product's prompt over the selected evidence | arm, exam, injected guidance |

The exam scorer uses a prompt written for this experiment, not the grader's.
The grader excludes assistant text by design, and the leakage probe checks that.

### Arms

In every arm the same simulated learner works the same tasks with the same
agent, which always has the Halyard manual. The arms differ only in what
Learner adds to the agent's context:

- `on`: Learner as shipped. The agent's turns go through the hook and the
  agent sees Learner's injected text and guidance.
- `off`: no Learner. The agent works from the manual alone; nothing is stored
  or graded.
- `control`: the hook's storage and grading run as in `on`, but the agent sees
  irrelevant text of the same length instead of Learner's. It separates "Learner's
  content helps" from "a longer context helps".
- `randomized`: `on` with the randomized-injection and blind-probe policy.
- `frozen`: `on`, but the learner keeps no notebook, so its true knowledge
  between sessions cannot change. It is the no-learning control for claim 2.

**Primary contrast**: within learner, blind exam gain on taught concepts minus
held-out concepts, `on` minus `off` (a difference of differences). It removes
between-learner variance (each learner is its own control) and Learner never
injects a held-out concept.

| Arm | Agent gets | Policy |
|---|---|---|
| `on` | hook text + guidance | product default (quota injection, 40%) |
| `off` | nothing extra; Learner is never called | none |
| `control` | irrelevant text (alpine-botany notes) of exactly the length the hook text would have had | product default (the submission still happens, so turns are stored and graded the same way) |
| `randomized` | hook text + guidance | `randomizedInjection: true`, `injectionRate: 60`, `blindProbes: true`, `probeRate: 40` |
| `frozen` | hook text + guidance | product default; but the learner keeps NO notebook (no model call, empty text), so what it knows between sessions is zero by construction and every exam equals the baseline |

The frozen arm measures the grader ratchet directly. The live grader is anchored
on its own previous estimate (slope 0.94) and almost never lowers it (per
grading: 77.7% equal, 21.8% up, 0.5% down). So an arm that is graded more often
rises without learning, and an arm that produces more evidence gets graded more
often. In `frozen` the true change between sessions is 0. Any rise in Learner's
readings there is drift, not learning: within a session the learner still talks
about what the agent just said, and that is the evidence the grader reads.

### Lanes (learner speed, enforced by code)

A lane is two numbers in `learning-sim-memory.ts`, applied by code so that a
slow learner cannot behave like a fast one:

| Lane | capacity (characters of new notes per session) | forget (chance a stored fact is gone by the next session) |
|---|---|---|
| `slow` | 100 | 0.08 |
| `medium` | 200 | 0.05 |
| `fast` | 400 | 0.02 |

The model is told the budget and lists its most important facts first; facts
are kept whole, in order, until the budget is spent, and the rest are recorded
as over capacity (never truncated). The budget is in characters because, given
a count of facts, the model packed two or three facts into each sentence
(calibration 34b55389). Calibration 62daf118 (108 calls, 2.8 min wall) is the
accepted one: final exam by dose 0/1/2/4 is slow 0/33/35/86, medium
0/55/78/97, fast 0/91/97/99, monotone in every lane, 0 at dose 0. Forgetting is a deterministic draw per
(learner, topic, fact, session), so a replay forgets the same facts. The
learner writes its next facts after forgetting and does not know what it lost.
A restated fact costs no capacity, so repetition relearns what was forgotten.
Concepts taught in the same session compete for the capacity, which is what
makes repeated teaching (a higher dose) add knowledge gradually.

### Calibration (before any arm runs)

The learner model is calibrated with Learner switched off entirely: no hook, no
agent model, no grader (`packages/runtime-p*/scripts/sim-calibration.ts`,
`learning-sim-calibration.ts`). Four concepts with little overlap (keel key,
draft limit, refit, slack window) each have a fact sheet of eight atomic facts
(`learning-sim-facts.ts`), each tested by one question; one
explanation states all eight. A concept is explained 0, 1, 2 or 4 times over
seven sessions, one concept per session (schedule 4, 2, 4, 2, 4, 1, 4) so
concepts never compete for capacity. The learner keeps its notebook under its
lane's memory model; the blind exam (32 questions) runs after session 7. Four
replicates per lane rotate the concepts through the doses (a Latin square):
3 lanes x 4 replicates x 9 calls = 108. Pass: within each lane the final
score rises with the dose and stays near 0 at dose 0; between lanes the scores
separate (slow needs about 4 doses, medium 2, fast 1 to reach 80).

Two earlier calibrations shaped this: with the curriculum's 3 questions per
concept and an uncapped notebook (916dea5f), one explanation took every
concept to the ceiling (dose 1/2/4 = 92/92/88). With capacity and forgetting
but still 3 questions (9fbdbad2), lanes separated only at dose 1; two facts
answered a whole concept, and the dose 2/4 differences were within one
question (17 points) of scorer noise. Ceiling controls, when needed: the exam
answered open-book from the explanations, and the rubric's full-credit wording
scored as the answer (3 calls, `--ceiling`).

### Model calls

Every call goes through Learner's LLM layer with the backend set to the Codex
CLI (the owner's ChatGPT subscription): `callLLM(... backend: 'codex')` for the
roles, and the product's assessment service for grading. Every call is keyed
(run, learner, call key) and its result written once to `learning_sim_calls`
with model, effort, tokens, duration and attempts: a step that runs again (a
resumed workflow, a re-started runner with the same `--run-id`) reads the
receipt and never pays twice. The grader has its own receipts and its own
fence. Capacity failures ("high demand", 429, 503, stream disconnects) are
retried in the step after 30 s and 60 s; after that the step fails and the
workflow retries it 3 minutes later (5 retries). Only catalogued models are
used: an uncatalogued name such as `gpt-6-luna` is silently remapped by the CLI
(to `gpt-5.6-sol`).

Defaults: learner `gpt-5.6-luna` low, agent and scorer `gpt-5.6-luna` medium,
grader the product's default (`gpt-5.6-luna` xhigh).

### Isolation

- Writes happen only on `learner_sim` (the runner, derived from `DATABASE_URL`)
  or `learner_sim_test_<checkout>` (the suite's test, one per checkout, named from a hash of its path so a lane with an unpushed migration never breaks another's suite): `assertSimDatabase` refuses any
  other database. The owner's `learner` database, the shared `learner_test`
  (a fictional curriculum there is read by every other test file) and the live
  services on :3010 are never touched.
- The runner has its own pg-boss schema on `learner_sim` and drops
  every `LEARNING_*` feature flag, schedule flag and foreign database URL from
  its environment. Automatic assessment, exposure drains or vector turns would
  otherwise add model calls and readings the experiment does not control.
- The runner unregisters the telemetry outbox: simulated calls are recorded in
  `learning_sim_calls` and never reach the owner's Langfuse traces.
- One run's orchestrations are serialized per process (a patch to the
  framework's workflow service). Two overlapping orchestrations of one run
  shared its step counters, so a learner skipped ahead or repeated steps.
- Simulated users are `sim-<run8>-<learner>`.

## Pre-registered analysis

Fixed before the main run. The unit is the learner (the unit of assignment).
All intervals are 95% percentile bootstrap over learners (4000 resamples, fixed
seed). Exam scores are percent of points; a concept's score is its 3
questions' points over 6.

**Claim 1 (injection improves understanding)**

- Primary: within learner, (taught gain - held-out gain) on the blind exam,
  `on - off`, with CI. Held-out concepts never receive guidance, so a real
  effect makes this positive in `on` and not in `off`.
- Between learners: final-minus-baseline exam gain, `on - off`.
- Specificity: `on - control` (the effect is not "more context").
- Secondary: `randomized - off`; per lane; the exam trajectory per session.
- Supported only if the primary CI excludes 0 AND `on - control` points the
  same way. Anything else is reported as "not shown", never as "no effect"
  unless the CI is narrow around 0.

The primary outcome is the exam for exactly this reason: every arm is examined
at the same fixed times (baseline, then after each session), the same number of
times, on the same 104 questions, by a scorer that sees neither the arm nor any
earlier score or estimate.

**Claim 2 (reporting is accurate)** (secondary: Learner's readings, always shown
next to the number of gradings per arm and per learner x concept)

Pairs: (learner, concept, session) where Learner has an estimate, against the
exam score for that concept after the same session.

- Pearson and Spearman correlation; mean absolute error and bias in points.
- Sign agreement: of consecutive readings that changed, the share whose exam
  moved the same way.
- Calibration table: reading bins (0-19 ... 80-100) against the mean exam.
- Gain notifications (`masteryNotifications`, the product's own rule): a gain is
  false when the exam for that concept did not rise between the reading it beat
  and this one. Report the count and rate.
- Known truth: the learner's knowledge is its notebook, and the exam reads
  exactly that. Per (learner, concept) with 2+ readings: reported change (last
  minus first reading) against the exam's change over the same sessions, per
  arm (mean reported, mean true, mean abs error, up/down/flat counts) and the
  correlation across all. In `frozen` the true change is 0.
- Ratchet: the frozen arm's reported change (should be 0).
- Holdout effect as reported by Learner (taught vs held-out readings) against
  the exam's taught vs held-out difference, per arm.

**Validity checks (reported with every run)**

- Grader test-retest on identical evidence: mean |diff| and sd. A reported
  change smaller than this is noise.
- Leakage: assistant-only explanations must earn nothing (credited above 10% is
  a failure).
- Held-out concepts never injected (count must be 0).
- Differential opportunity: per arm, how often agent and learner turns mention
  taught vs held-out concepts, plus blind-probe deliveries. If Learner arms
  talk about taught concepts more often, the grader sees more evidence there,
  and a reading difference can come from that alone.
- Notebook truncation per lane; dropped (invalid) agent tags; incomplete
  learners (excluded, and listed).

## Batch 2 (`--design v2`)

Batch 1 could not answer claim 1 by design. The agent held every exam fact in every arm. Injection changed neither
what nor how much the agent taught. The fixed holdout (the catalog hash) was confounded with three particular concepts.
Batch 2 gives injection a lever without handing it the win. The review of 5354994 found that the first version still
leaked exam answers, kept the budget as bookkeeping only, and gave the memory model no mechanism that targeting could
use. This section is the revised design.

**What the result means.** Batch 2's learner is a language model with a capacity-limited notebook, under the memory
rules below. The result is conditional on those rules. It says nothing about a real person's memory. Learner runs the
shipped policy with `spacedRepetition` on, which is not the product default (off). The result therefore says nothing
about the product as shipped by default either. The pre-registration and the report header state both.

### No exam answer outside the fact channel

- **The agent's manual is concept names only.** `HALYARD_MANUAL_V2` lists the 13 concepts and what each builds on.
  The batch-1 manual stated 85 of the 104 exam answers; this one states none.
- **The briefs state no answer.** The five incidents no longer quote error codes, metric names or defaults. For
  example, "draft from 64" became "draft limit to 512", and `LAPSED` became "pinned reads fail with an error".
- **A suite test checks every arm's base prompt.** The test covers the agent prompt with and without the hook's
  context, and the learner's prompt, for each of the five briefs. It fails when any window of two sentences gives an
  exam answer: at least 80% of the answer's content tokens (an error code in its own case), with the question's
  concept named. Eight answers are exempt because they are a concept's own name ("a tessel", "a rebraid"); an answer
  with a number is never exempt. Its positive control is the batch-1 manual, which must fail it.

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

`MEMORY_V2` in `learning-sim-memory.ts`. The values were set before the ceiling simulator first ran and before any arm
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

### Pre-registration (`BATCH2_PREREGISTRATION`, learning-sim-analysis.ts)

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
  --per-arm 1 --sessions 3 --turns 4 --concurrency 4

# re-analyze a run (reads receipts only, no model call)
bun --env-file=/etc/learner/db.env packages/runtime-p*/scripts/sim-experiment.ts --run-id <id> --analyze-only
```

`learner_sim` is created once:
`sudo -u postgres psql -c "CREATE DATABASE learner_sim OWNER learner"`, then
migrated with `migrateToLatest` on its URL.

Each learner is a workflow run in `learner_workflow_runs` on `learner_sim`.
One step per action, so a step shows its kind, session, turn and concept in its
input, and the per-call receipts are in `learning_sim_calls`.

The suite's test (`simulated-learner.test.ts`) runs on its own database,
`learner_sim_test_<8 hex>` (`own-test-database.ts`: one per test run where the role may create it, as in
CI and the pre-push gate; otherwise the admin-created one per checkout; otherwise the file is
skipped), and migrates it. It runs one learner per arm through the queued workflow with a deterministic stub transport and stub grader model
(about 5 s), checks the call counts per role, that Learner turns used the
Halyard catalog, that the off arm never called Learner, that no held-out concept
was injected, that the frozen learner's exam never moves, and that a rerun pays for nothing. It proves the loop is wired,
never an effect. `SIM_LIVE=true` runs the same test on the real Codex transport.

## Known limits

- Simulated learners are models: their "understanding" is what they write in
  a notebook and can retrieve under exam conditions.
- Evidence selection is term matching, not the product's retrieval.
- The agent is told the manual in every arm, so the agent can teach in any arm.
  What Learner adds is which concepts to raise and when, not the knowledge
  itself.
- Readings use `getMasteryChanges` / `getHoldoutEffect` only indirectly (the
  analysis reads `learning_mastery_readings`, receipts and
  `masteryNotifications`); comparing those RPCs' outputs directly is a
  follow-up.

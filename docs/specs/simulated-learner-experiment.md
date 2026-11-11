# Simulated-learner experiment

Status: harness, end-to-end test and pilot landed; the main run has NOT been
started. Code: `packages/core/src/lib/learning/learning-sim-*.ts` (curriculum,
prompts, model calls, steps, analysis),
`packages/server/src/wirings/learning-sim-learner.workflow.ts` (the durable
workflow), `packages/server/src/functions/learning/learning-sim-experiment.function.ts`
(its steps), `packages/runtime-pikku/scripts/sim-experiment.ts` (the runner),
`packages/runtime-pikku/tests/simulated-learner.test.ts` (the suite's test),
tables from migration 0026.

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
agent and a 39-question exam (3 per concept, rubric 0/1/2). Fictional, so no
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
   - After the last turn, the learner rewrites its **notebook** under the lane's
     hard character limit. Text over the limit is cut and lost. The notebook is
     the learner's only memory between sessions.
   - **Grading** by Learner, per concept: the product's
     `LearningConceptAssessmentService` (default model and prompt), on evidence
     selected by term matching over the learner's own turns and the agent reply
     after each (a stand-in for retrieval). A concept with no evidence, or with
     the same evidence as last time, is not regraded.
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
step is one model call or one grading, so it stays well inside pg-boss's
15-minute job expiry.

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

| Arm | Agent gets | Policy |
|---|---|---|
| `on` | hook text + guidance | product default (quota injection, 40%) |
| `off` | nothing extra; Learner is never called | none |
| `control` | irrelevant text (alpine-botany notes) of exactly the length the hook text would have had | product default (the submission still happens, so turns are stored and graded the same way) |
| `randomized` | hook text + guidance | `randomizedInjection: true`, `injectionRate: 60`, `blindProbes: true`, `probeRate: 40` |

### Lanes (a real constraint, not a persona)

The notebook limit is the lane: `slow` 400, `medium` 1000, `fast` 2400
characters. A learner can carry only what fits, so a lane changes how much
injected teaching can survive between sessions.

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

- Writes happen only on `learner_sim` (the runner derives it from
  `DATABASE_URL`) or a test database: `assertSimDatabase` refuses anything else,
  and the runner refuses a database other than `learner_sim`. The owner's
  `learner` database and the live services on :3010 are never touched.
- The runner has its own pg-boss schema (`learner_pikku_boss_sim`) and drops
  every `LEARNING_*` feature flag, schedule flag and foreign database URL from
  its environment. Automatic assessment, exposure drains or vector turns would
  otherwise add model calls and readings the experiment does not control.
- Simulated users are `sim-<run8>-<learner>`.

## Pre-registered analysis

Fixed before the main run. The unit is the learner (the unit of assignment).
All intervals are 95% percentile bootstrap over learners (4000 resamples, fixed
seed). Exam scores are percent of points; a concept's score is its 3
questions' points over 6.

**Claim 1 (injection improves understanding)**

- Primary: final-minus-baseline exam gain, `on - off`, with CI.
- Specificity: `on - control` (the effect is not "more context").
- Within learner: (taught gain - held-out gain), compared `on - off`. Held-out
  concepts never receive guidance, so a real effect makes this positive in
  `on` and not in `off`.
- Secondary: `randomized - off`; per lane; the exam trajectory per session.
- Supported only if the primary CI excludes 0 AND `on - control` points the
  same way. Anything else is reported as "not shown", never as "no effect"
  unless the CI is narrow around 0.

**Claim 2 (reporting is accurate)**

Pairs: (learner, concept, session) where Learner has an estimate, against the
exam score for that concept after the same session.

- Pearson and Spearman correlation; mean absolute error and bias in points.
- Sign agreement: of consecutive readings that changed, the share whose exam
  moved the same way.
- Calibration table: reading bins (0-19 ... 80-100) against the mean exam.
- Gain notifications (`masteryNotifications`, the product's own rule): a gain is
  false when the exam for that concept did not rise between the reading it beat
  and this one. Report the count and rate.
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

## Running it

```bash
# plan only: the call count per role (grading is an upper bound)
bun --env-file=/etc/learner/db.env packages/runtime-pikku/scripts/sim-experiment.ts --dry-run --per-arm 6 --lanes slow,medium,fast --sessions 5

# run (or resume, with the same --run-id); results in /var/lib/learner/sim/<runId>/
LLM_CLI_MAX_CONCURRENT=4 bun --env-file=/etc/learner/db.env packages/runtime-pikku/scripts/sim-experiment.ts \
  --per-arm 1 --sessions 3 --turns 4 --concurrency 4

# re-analyze a run (reads receipts only, no model call)
bun --env-file=/etc/learner/db.env packages/runtime-pikku/scripts/sim-experiment.ts --run-id <id> --analyze-only
```

`learner_sim` is created once:
`sudo -u postgres psql -c "CREATE DATABASE learner_sim OWNER learner"`, then
migrated with `migrateToLatest` on its URL.

Each learner is a workflow run in `learner_workflow_runs` on `learner_sim`.
One step per action, so a step shows its kind, session, turn and concept in its
input, and the per-call receipts are in `learning_sim_calls`.

The suite's test (`simulated-learner.test.ts`) runs one learner per arm through
the queued workflow with a deterministic stub transport and stub grader model
(about 5 s), checks the call counts per role, that Learner turns used the
Halyard catalog, that the off arm never called Learner, that no held-out concept
was injected and that a rerun pays for nothing. It proves the loop is wired,
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

# Simulated-learner experiment

Status: batch 1 (e54225af, design v1) finished and is written up; that design is
retired and its code deleted. Batch 2 runs on the design below, which is the only
one the code implements. Its first pilot (0946448d) is void; revision 7 (see "Pilot and cost") fixed the two
validity failures it found; revision 8 screened the exam (see "The exam screen"), and the pilot reruns before any main batch. Code: `packages/core/src/lib/learning/learning-sim-*.ts`
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
refit, squall), five incident briefs, a manual of concept names for the agent, a fact sheet per concept and an
exam of one question per fact (rubric 0/1/2). The sheets were written with eight facts each (104); revision 8's
screen (below) dropped 40, so the sheets hold 2 to 6 facts and the exam has 64 questions. Fictional, so no
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
    table is built; a new implied pair is a limit (Known limits), never a post-hoc drop.
  - **A suite test runs the screen mechanically** ("revision 8: no scored item can be answered without the
    notebook", learning-sim-rules.test.ts). It flags an item whose answer is yes/no, appears in a task title, brief,
    the manual or another scored question (after stripping articles, parentheticals and filler words), or is a
    concept's title. It asserts that no scored item is flagged, that the implied ids are absent, and, as its positive
    control, that each non-implied dropped item, put back, is flagged for its recorded reason. A new leaky item fails
    the suite.

### The budget is enforced at the channel

- **Fact sheets are the only source of facts.** The agent sees the sheets of the concepts the brief or the learner's
  message names. It also sees up to 2 concepts it asked for on its previous turn (`lookups`).
- **Each session has a budget** of `round(capacity / 50)` facts: slow 2, medium 4, fast 8.
- **An arm-blind matcher reads every reply before the learner does** (`learning-sim-matcher.ts`). It knows nothing of
  the arm or the policy.
  - A sentence, read with the one before it, states a fact in two cases: it holds at least 60% of the fact's content
    tokens with the fact's concept named, or 85% outright. It also states a fact when it gives that fact's exam answer
    with the concept named.
  - The matcher finds each of the 64 scored facts in its own text and nothing else.
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

Final exam, mean points, on the revision-8 exam (64 scored items; every figure in this table and its bullets was
recomputed for it unless marked "104-item exam"):

| rules | lane | off (sd) | oracle | omniscient | oracle - off | omniscient - off | briefed 9: off (sd) | oracle - off |
|---|---|---|---|---|---|---|---|---|
| all rules | slow | 2.3 (2.1) | 5.0 | 7.9 | 2.7 | 5.6 | 3.4 (3.1) | -2.3 |
| all rules | medium | 7.6 (3.4) | 11.9 | 17.4 | 4.3 | 9.8 | 11.1 (4.8) | -7.0 |
| all rules | fast | 19.1 (5.4) | 28.0 | 34.6 | 8.9 | 15.5 | 27.5 (7.8) | -10.7 |
| forgetting off | slow | 4.7 (2.5) | 8.6 | 16.6 | 4.0 | 12.0 | 6.7 (3.7) | -3.9 |
| forgetting off | medium | 13.2 (4.6) | 19.5 | 30.7 | 6.4 | 17.6 | 18.9 (6.4) | -12.7 |
| forgetting off | fast | 26.9 (5.0) | 42.3 | 52.8 | 15.4 | 25.9 | 38.7 (7.2) | -15.5 |
| forgetting halved | slow | 3.3 (2.2) | 6.5 | 10.5 | 3.2 | 7.2 | 4.8 (3.2) | -3.4 |
| forgetting halved | medium | 9.8 (3.7) | 15.5 | 22.8 | 5.7 | 12.9 | 14.2 (5.2) | -9.2 |
| forgetting halved | fast | 21.9 (4.6) | 34.5 | 42.6 | 12.5 | 20.7 | 31.7 (6.7) | -12.3 |
| spacing off | slow | 2.3 (2.1) | 4.8 | 7.9 | 2.5 | 5.6 | 3.4 (3.1) | -2.3 |
| spacing off | medium | 7.5 (3.3) | 11.6 | 17.4 | 4.1 | 9.9 | 10.8 (4.7) | -6.8 |
| spacing off | fast | 18.7 (5.3) | 27.6 | 34.5 | 8.9 | 15.8 | 27.0 (7.8) | -10.4 |
| spacing halved | slow | 2.3 (2.1) | 4.9 | 7.9 | 2.6 | 5.6 | 3.4 (3.1) | -2.3 |
| spacing halved | medium | 7.6 (3.4) | 11.8 | 17.4 | 4.2 | 9.8 | 11.1 (4.8) | -7.0 |
| spacing halved | fast | 18.9 (5.4) | 27.9 | 34.6 | 9.0 | 15.6 | 27.3 (7.9) | -10.6 |
| prerequisites off | slow | 5.7 (2.1) | 5.5 | 8.4 | -0.3 | 2.7 | 8.4 (3.1) | -6.9 |
| prerequisites off | medium | 14.5 (3.2) | 12.4 | 19.8 | -2.1 | 5.3 | 21.0 (4.8) | -16.9 |
| prerequisites off | fast | 30.4 (4.2) | 28.9 | 36.6 | -1.5 | 6.2 | 43.9 (6.1) | -26.3 |
| prerequisites halved | slow | 4.2 (2.3) | 5.2 | 8.3 | 1.0 | 4.2 | 6.0 (3.5) | -4.8 |
| prerequisites halved | medium | 11.3 (3.7) | 12.2 | 19.6 | 0.9 | 8.3 | 16.4 (5.2) | -12.3 |
| prerequisites halved | fast | 25.1 (5.3) | 28.4 | 36.0 | 3.3 | 10.9 | 36.3 (7.6) | -19.1 |
| graph perturbed | slow | 2.3 (2.1) | 4.5 | 9.7 | 2.3 | 7.4 | 3.4 (3.1) | -2.6 |
| graph perturbed | medium | 7.2 (3.6) | 9.7 | 18.6 | 2.5 | 11.4 | 10.4 (5.1) | -7.9 |
| graph perturbed | fast | 17.9 (5.3) | 21.4 | 38.0 | 3.5 | 20.1 | 25.9 (7.7) | -15.4 |

What the table says (the simulator's PRNGs are merged into one, `seeded` in `learning-sim-memory.ts`). Revision 8 roughly
doubled every level and gap: each scored fact now weighs more (a concept's score is over its 2 to 6 scored items, not 8):
- **The oracle's whole advantage comes from the prerequisite rule.** With that rule off, oracle is no better than off
  (and worse in every lane). Halved, it is at most 3.3 points.
- **It also depends on the product's graph being the true one.** `graph perturbed` keeps every rule but gives each
  edge a seeded random prerequisite in the world, while the oracle policy still plans by the product's graph. The
  oracle's gain over off falls to 2.3, 2.5 and 3.5 (from 2.7, 4.3 and 8.9). The ceiling is therefore a statement about
  a world whose prerequisites are the ones the product believes, and says nothing about one where they are not.
- **Spacing changes nothing at these budgets** (±0.2). No policy can afford to re-teach a held fact when every
  budgeted fact is needed for new material.
- **Forgetting lowers every level but barely changes the gaps.**
- **The absolute scale is set by the fact budget.** At 2, 4 and 8 facts per session over 5 sessions, no policy can
  deliver more than 9.6, 19.2 or 38.5 exam points on the 104-item exam; on the revision-8 exam the cap depends on
  which facts are taught (a twin-rule fact is worth 3.8 points, a beat fact 1.3).
- **Why the oracle loses on the briefed concepts.** Scored on the 9 concepts some brief names (last two columns),
  oracle minus off is -2.3, -7.0 and -10.7. The ceiling's `off` teaches only concepts its brief names, so it scores
  0 on the 4 foundations (tessel, keel-key, rebraid, mooring). The oracle plans over the whole exam, and it puts most
  of its fixed budget there: in whole-exam points (104-item exam) it scores 2.0 / 5.6 / 13.1 on foundations and 0.3 / 1.6 / 4.0 on the
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
  omniscient policy beats off on the briefed 9 as well (2.3 / 6.4 / 17.0 against 1.3 / 4.7 / 11.5, whole-exam points,
  104-item exam),
  so the briefed scope is not out of reach for an informed policy; the oracle heuristic simply spends its budget
  elsewhere. Two consequences, both pre-registered: the primary scope stays the whole exam, and the briefed/foundation
  split of on − off is read as WHERE an effect comes from, never as its sign. An `on` arm that teaches foundations can
  show a negative briefed split and a positive whole-exam gain, as the oracle does here.
- **Slow and medium cannot show an effect at an affordable size.** The oracle gain is +2.7 (slow) and +4.3 (medium).
  At 30 per arm (MDE 0.74 SD) slow would need SD ≤ 3.7 against a no-model floor of 2.1 and medium SD ≤ 5.8, and running
  `on` in medium too would take the main batch past the 6,600-call cap. Both run arm off only; the primary is fast
  (+8.9, needs SD ≤ 12.1). See
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
grading starts, its worst case (2 × gradingReplicates calls) is checked against the cap and written to the ledger at
once as a pending row of the grading (revision 8.3), so concurrent gradings and every other call see it; a grading
that would pass the cap does not start. When the grading settles the row is set to what it paid: 1 per main call and
per replicate, plus 1 for a validator repair (revision 8.2; before it, the pilot's ledger missed 3 such calls of
126), plus 1 per lease takeover, i.e. a call re-run after its worker died (revision 8.3). So the cap, the retry
share r and the health look count it.

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
  | slow | +2.7 | +5.6 | ≤ 3.7 | 2.1 | **No.** The SD it needs is under twice a perfect note taker's (batch 1's real learners ran several times their floor). Dropped: arm off only. |
  | medium | +4.3 | +9.8 | ≤ 5.8 | 3.4 | **Only at a low SD, and not affordable.** Adding `on` 30 and 28 more `off` there costs about 5,100 calls (120.4 and 53.4 per learner), beyond the 6,600 cap. Dropped: arm off only. |
  | fast | +8.9 | +15.5 | ≤ 12.1 | 5.4 | **Only if the pilot's SD is ≤ 12.1**, and +8.9 is a ceiling heuristic's gain, not the shipped policy's. The primary. |

  (Revision 8 exam, 64 items. On the 104-item exam the three rows read +1.1 / +2.8 / +5.0, SD ≤ 1.5 / 3.8 / 6.8, floor
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
  fast) is 5.4 on the revision-8 exam (2.9 on the 104-item exam, where batch 1 implied about 10; with fewer items
  each worth more, the real SD should scale up by about the same factor, 1.9).
  - **Not powered for the smallest effect of interest:** 2 points needs SD ≤ 2.7, below the no-model floor of 5.4.
    The smallest effect of interest stays 2 (it is a statement about learning, not about this exam), so on this exam
    it is out of reach.
  - **+8.9 is the gain of a ceiling heuristic** (prerequisites first, a sheet at a time), not of the shipped policy.
    A realistic effect may be half that, and at +4.5 the power is 93% at SD 5 and 57% at SD 8.
  - **"No effect of 2 points or more" is practically unreachable.** At a true 0 it is reached 80% of the time only at
    SD ≤ 2.65, half the no-model floor of 5.4 (65% at SD 3, 23% at 4, 0% at 4.7). A null result will read "inconclusive"
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
  - The stall alarm is not a stop: the runner is restarted with the same run id and resumes the open block without
    re-running ended learners.
  - **Noise gate**, from the pilot only: if the pooled within-arm SD of the fast lane's whole-exam gain (arms on and
    off) is above 12.1 (an MDE above the fast oracle gain, +8.9; it was 6.8 and +5.0 on the 104-item exam, and it
    scales because it is derived from that gain), there is no main batch; a further batch is a new pre-registration.
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
  - unbudgeted knowledge about 0 and balanced: on the final exam, facts scored 2 that the channel never delivered
    within budget average at most 0.5 per learner in `on` and in `off`, and the two averages differ by at most 0.2
    (about 0.3 exam points on the 64-item exam; 0.2 on the 104-item exam). The facts limit is unchanged by revision 8:
    it counts facts, not points. The channel's lexical matcher stops 12 of the 18 loose paraphrases of scored facts
    (15 of 24 over the 104 items; 13 before revision 7 stopped counting placeholders such as `<name>` as content; the
    reviewer's harsher set: 2 of 15 scored, 4 of 24 before); a tighter rule flagged 10-37% more of batch 1's agent sentences, mostly task talk, so the bound
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
`endedPairs`), `learning-sim-health.ts` (health looks), the runner's `--sequential`, `--health` and `--concurrency`;
tests in `learning-sim-sequential.test.ts` and `learning-sim-rules.test.ts` ("revision 8: interim looks …", "revision 8:
the health look is arm-blind …").

- **Matched pairs.** The k-th `on` and `off` learners of the fast lane are a pair (`config.pair` = `simSlots`
  cellIndex): the same holdout block and Williams row, and the memory rules' draws (forgetting, prerequisite
  absorption) keyed by run, lane and pair instead of by learner. The primary is the mean over primary lanes of the mean
  paired difference in whole-exam gain, complete pairs only; its interval is the paired t interval (df = pairs −
  lanes) at the stopping look, not adjusted for stopping (an early efficacy stop overstates the size; the table under
  "Bias at a stop" is printed beside it). The
  delivered-only check uses the same pairs. Within-pair correlation: 0.24 on the no-model simulator (fast lane; SD of
  the difference 6.8 against 7.8 unmatched); the LLM learner's own sampling dilutes it, to about 0.1 at SD 8 and near
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
| +4.5 | 5 | 0.24 | 96.2% | | | | ~4,630 |
| +4.5 | 8 | 0 | 53.2% (fixed: 56.1%) | 0.4% / 20.4% / 32.4% | 10.5% / 1.3% | | ~5,190 |
| +4.5 | 8 | 0.1 | 57.8% (fixed: 60.4%) | | | | |
| +8.9 | 5 | 0 | 100% | | | 17.6 | ~3,800 |
| +8.9 | 8 | 0 | 98% | | | | ~4,500 |

- **Two kinds of look, kept separate.**
  - *Health looks*: unlimited, from the first ended learner on: `sim-experiment.ts --run-id <id> --health`
    (read-only connection). Arm-blind or pooled only: learner statuses and failed ids, calls, pending calls, paid
    invocations, retried calls (a parse retry, or a grader validator repair) and 429s by role, call durations, the validity gates pooled (unbudgeted facts per
    learner, echo, the channel, the never-learns control) and per-item exam screening pooled over arms (items at full
    credit on ≥ 90% of final exams, items never at full credit, items the control got right). Ids and counts only, no
    learner text. It never computes or prints a between-arm outcome difference; the suite checks that swapping every
    `on`/`off` label leaves its output identical. Known and accepted: two health looks either side of one learner's
    completion difference to that learner's pooled numbers (its unbudgeted count, its item marks), and a failed id can
    be joined to config.json for its arm. Neither is a between-arm outcome: one learner, no comparison.
  - *Efficacy looks*: only at 10, 20 and 30 pairs whose learners have all ended (`endedPairs`), by the runner. Until
    the sequence stops, the analysis returns no between-arm number (outcome, claim 2 and the per-arm exam-derived
    mechanism columns are withheld or pooled) and the runner prints the decision only.
  - *Durable looks* (revision 8.1, review 7 B2). Each efficacy look is written once, when taken, to
    `look-<k>.json` beside config.json (created exclusively, like config.json) and is never re-taken or revised: a
    restart adopts the recorded looks and resumes at the first block without one, so a printed stop stays a stop. A
    look reads only the learners of the blocks it covers (never a later block's, which may be mid-run), and a block
    already looked at is never started again, so a learner counted incomplete at a look stays so.
  - *`--analyze-only` during the sequence* refuses (exit 6) until the recorded looks have stopped it: its report has
    between-arm numbers (dose, pooled denominators, per-arm noise and unbudgeted lines) from pairs no look has read.
    Read `--health` until then. Once stopped, it also checks that the recorded decisions are what the data give; a
    difference fails the frozen-code check and withholds the verdict.
  - `--sequential` is pinned in config.json and required for an allocation whose primary lane has ≥ 10 learners per
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
- **Concurrency.** `--concurrency` (default 6, maximum 9) sets the model-call slots (`LLM_CLI_MAX_CONCURRENT`) and
  the workflow concurrency. Before revision 8 the runner never set the slots, so every batch ran on the default 3. A
  429 (Too Many Requests) is never a learner outcome: it pauses every slot (backoff doubling from 30 s, capped at 5
  min, times a random 0.5–1.5), is not an attempt and not a paid invocation (it is counted as `rateLimited` on the
  receipt and in the health look; it never counts against `--max-calls`), and two 429s in a row drop the slots one
  step (not below 2; one burst of concurrent 429s drops one step, not one per 429), and 20 successes in a row take a
  step back up, never above `--concurrency`. A step still rate-limited
  after 10 minutes fails as a capacity error; the workflow retries it, and the runner restarts a failed learner (twice
  per block per process; then it exits 5 without taking the look, and the supervisor restarts it).
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
    graded sessions; then, for every `on` learner, (a) every recorded grading of every graded session has settled
    (completed, failed, no evidence or unchanged; none pending past 450 s or refused), and (b) from session 2 on, the
    session has at least one non-null reading. A failed grading settles: it does not fail (a), and the report prints,
    per learner and session, the gradings completed / failed / pending or refused and the concepts with a reading. A
    session whose concepts were all skipped for no new evidence records no grading and passes (a); a lost grading is
    told apart because it never settles, so its learner's workflow does not complete and the incompletion check
    reports it (from session 2 on, (b) fails as well). Revision 8.2 changed this gate after pilot db59766b, from arm-on
    grading receipts, no outcome, and before any outcome existed; revision 8.3 made (a) and the session floor what
    they are now. The old
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
- **Cost** (`--dry-run`, 5 sessions, 3 turns, k = 1; call keys, grader calls an upper bound; the totals move by a few
  calls with the run id, which draws the 10% of exams scored twice). Per learner: `off` about 53.4, `on` 120.4,
  `oracle` 68.6; the never-learns control about 120 (arm `on`).
  - Pilot: `--lanes none,slow,medium,fast --arms off,on,oracle --per-arm off=1,on=0,oracle=0 --per-arm-fast off=3,on=3,oracle=1 --per-arm-none off=0,on=2,oracle=0 --max-calls 990`,
    936-942 call keys (694-700 without the control). The cap is the main batch's formula on the pilot:
    ceil(942 × (1.05 + r)) with r = 0, the void pilot's measured retry share.
  - Main: the same with `--per-arm off=2,on=0,oracle=0 --per-arm-fast off=30,on=30,oracle=4 --per-arm-none off=0,on=2,oracle=0 --max-calls <the cap below>`,
    5,940-5,955 call keys (5,695-5,714 without the control). At r = 0 the cap is ceil(5,955 × 1.05) = 6,253; it stays
    ≤ 6,600 while r ≤ 0.058 (0.155 without the control). Its cap is pre-stated as `--max-calls` = ceil(K × (1.05 + r)): K the main allocation's
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
bun --env-file=/etc/learner/db.env packages/runtime-p*/scripts/sim-experiment.ts \
  --per-arm 1 --sessions 3 --concurrency 4 --max-calls <N>
# --max-calls is required on the real transport (exit 4 without it). The cap is checked before every paid
# invocation, retries and restarts included, so it overshoots by at most the calls already in flight.
# the main batch adds --sequential (blocks of 10 pairs, a look after each, recorded in look-<k>.json); exit 5: a
# learner still failed after two restarts, the look was not taken (the supervisor restarts the runner). A stopped
# sequence exits 0, even with learners accepted incomplete (--accept-failed), so the supervisor does not loop.

# the health look, any time, read-only, arm-blind (ids and counts only)
bun --env-file=/etc/learner/db.env packages/runtime-p*/scripts/sim-experiment.ts --run-id <id> --health

# the pilot and the main batch run supervised, so no step waits for a human (restart-safety rows 6, 8, 11):
# a killed runner, a stall (exit 3, after an ALARM line; --stall-minutes default 45, twice the longest healthy model
# step) or a failed learner (exit 1) is restarted with the same --run-id, and each boot takes the fence and recovers.
# Exit 2 (another runner holds the fence) and 4 (stale codegen) are not restarted. Three restarts in an hour leave
# the unit failed: the alarm that a restart did not heal.
systemd-run --unit=learner-sim-<id> -p Restart=on-failure -p RestartSec=30 -p RestartPreventExitStatus="2 4" \
  -p StartLimitIntervalSec=3600 -p StartLimitBurst=3 -p WorkingDirectory=/root/learner-lanes/sim-run-<id> \
  bun --env-file=/etc/learner/db.env packages/runtime-pikku/scripts/sim-experiment.ts --run-id <id> <the allocation above>

# who hears the alarm: this box has no notifier, so whoever starts the unit also starts this watch, and it ends with
# one line when the unit fails or stops; that person reports it to the operator (the lead, for the pilot).
until systemctl is-failed --quiet learner-sim-<id> || ! systemctl is-active --quiet learner-sim-<id>; do sleep 60; done; \
  systemctl status --no-pager learner-sim-<id> | head -5

# re-analyze a run (reads receipts only, no model call); only this report carries a verdict. On a sequential run it
# refuses (exit 6) until the recorded looks have stopped the sequence
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
- **Unbudgeted knowledge that is not a channel leak (stated before the rerun pilot).** Two revision-7 probes, arm `off`,
  fast lane (28f58f3b: 1 learner, 5 sessions; c79a615f: 2 learners, 4 sessions) left 2 and 9 unbudgeted final-exam
  facts (2.0 and 4.5 per learner against the gate's 0.5). Of the 9, one was claimed and redacted at the channel; the
  rest are yes/no questions answered right without a declared guess (4 of 9) and facts that follow from a delivered
  fact or from material every arm sees (the brief, the manual, the exam's other questions). The gate's definition
  is unchanged. Revision 8 dropped those items from the exam instead (above), but only the implied pairs actually
  observed: a fact implied by another delivered fact in a pair not yet seen can still score as unbudgeted, and a
  failure on those grounds voids the pilot as before. A general implication table would be a new pre-registration.
- **Residual dependence on guess declaration (after revision 8).** A declared guess scores 0 in every series (the
  primary, the unbudgeted count, the control's exam). In the void pilot learners declared 0 to 101 guesses of 104,
  and most of that variation sat on the yes/no items, which revision 8 dropped. What remains: an undeclared
  constructed answer (a code, a number, a name) that happens to be right scores 2 and counts as unbudgeted; one that
  is partly right can earn 1 point, which raises the primary and the control's exam but never the unbudgeted count
  (that counts 2s). Both are symmetric between arms by design. The control's exam measures their size directly;
  if it is not 0, the measured floor is reported and the gate's definition is the lead's decision, not changed here.

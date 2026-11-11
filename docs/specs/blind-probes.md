# Blind probes in the live intervention policy

Status: implemented, off by default. Settings `blindProbes`, `probeRate` and `probeHops`
in `LearningPolicySettings`; selection in
`packages/core/src/lib/learning/learning-blind-probes.ts`; delivered through
`taskTeachingContext`; columns from migrations 0023 (`probe_concept_id`), 0025 (the stored draw) and 0026 (the
picked concept's distance, the `fail_open` outcome).

## What it is for

The concept holdout (`osmosis-concept-holdout`) never teaches one concept in five and
compares how held-out and taught concepts move. But teaching a concept also makes the
agent ask about it, so taught concepts get more chances to show evidence: part of any
difference between the arms is how often we looked, not what the learner knows.

A blind probe is one short check question about a concept related to the turn, worded
the same whether the concept is held out or taught. It is a question, never a lesson.

## The rule

A turn decided with `blindProbes` on goes through these steps. None of them looks at
which concepts are held out: the arm is read off the picked concept afterwards.

1. **Draw.** `draw(turnId) < probeRate`, where `draw` is the first 28 bits of
   `md5("learning-probe:<turnId>")` modulo 100. Otherwise: `not_drawn`. (2^28 is not a
   multiple of 100, so draws 0 to 55 are likelier than the rest by 4 parts in ten
   million. Left as it is.)
2. **Task target.** The packet carries at least one of the turn's own concepts as a
   target. Otherwise: `no_target` (a probe never stands alone).
3. **Free slot.** The packet has fewer than five targets. Otherwise: `packet_full`.
4. **A candidate.** Candidates are the catalog concepts within `probeHops` of the turn's
   concepts (`relatedHops`, the spaced-repetition relatedness), except the turn's own
   concepts. Nothing else is excluded. There must be at least one. Otherwise:
   `arm_empty` (the stored name is from the earlier rule; it now means "no candidate at
   all").
5. **Size.** The guidance with the longest candidate line fits the 4,000-character
   ceiling. Otherwise: `size`.
6. **Pick.** Every candidate is equally likely, held out or taught: the candidates are
   ordered by a hash of turn and concept (`learning-probe-pick`) and the first is taken.
7. **Arm.** The arm of the picked concept. Nothing draws it. With `h` held-out and `t`
   taught candidates the probe is a held-out one with probability `h / (h + t)`.
8. **Delivery.** The probe goes out with the guidance, so only on an injected turn.
   Otherwise: `not_injected`. Injection is decided without the probe.

The guidance then ends with one extra line and one fixed instruction:

```
Blind probe: {"conceptId":"…","title":"…","role":"probe","hops":1,"relatedTo":"…"}
role "probe": a check, not a teaching target. End your reply with exactly ONE question in this form: "Quick check: in one sentence, what is <title>, and where would it matter in what we are doing?" Do not explain, define, hint at or teach that concept …
```

If the picked concept is one the packet was about to teach (a prerequisite or a review;
this can only happen in the taught arm), it is probed instead of taught on this turn and
leaves the teaching targets. Skipping such concepts would use a signal that held-out
concepts never have.

### Why the pick is uniform over both arms

Until 2026-11-11 the rule was: probe only a turn with a candidate in both arms, flip a
fair coin for the arm, pick uniformly inside it. One concept in five is held out, so a
turn has about four taught candidates for each held-out one, and the fair coin gave a
held-out concept about four times the probe rate of a taught one. Two things followed,
and both bias any comparison of the arms that is not made at equal time and equal
activity (review 3 of the mastery statistics, finding B1):

- **Timing.** A held-out concept reached its first probe early in the holdout and a
  taught one much later. Whatever the learner picks up with time, with no teaching at
  all, then reads as a taught-arm advantage, and a straight-line time adjustment only
  removes it when that learning is a straight line.
- **Selection.** At any date the taught concepts that had been probed were the ones
  nearest to the most turns, and the held-out ones were nearly the whole arm. If
  activity around a concept also drives what the learner knows about it, the probed
  taught concepts know more without teaching.

The cure is to give every concept the same probe rate in both arms. Three ways were
considered:

| Option | What it does | Why it was or was not taken |
|---|---|---|
| Weight the arm by the candidate counts (**taken**) | held out with probability `h / (h + t)`, then uniform inside the arm; that is the same as one uniform pick over all candidates, which is how it is written | exact on every turn, whatever the turn's mix; follows the holdout share by itself if that is ever changed; no arm coin left to audit |
| A fixed 20/80 coin | held out with probability 0.2 | equal only on average: a turn with one held-out and nine taught candidates would still favour the held-out one two to one. It also hard-codes the share |
| Keep the fair coin and thin the held-out first probes in the analysis | accept a held-out first probe with the ratio of the two rates | throws delivered probes away, needs the rates estimated, and leaves the learner asked four times as often about held-out concepts, which wears the holdout down |

**The "both arms" requirement is gone, on purpose.** It was needed for a fair coin (a
coin cannot land on an empty arm). With the weighted pick it would do harm: on the dev
turns 18 of 66 at 2 hops and 26 of 66 at 1 hop have taught candidates only (none has
held-out only), so a taught concept would be eligible on fewer of its turns than a
held-out one and the rates would be unequal again. Measured on the fixture graph
below, the uniform pick with the requirement kept: a held-out concept is probed 2.2
times as often per appearance at 1 hop and 1.4 times at 2 hops, and half the held-out
concepts have their first probe by turn 741 against 1,782 for the taught ones (428
against 846 at 2 hops). The fixture test fails on each of those figures.

What the change does to timing and volume:

- A concept's first probe arrives, in distribution, at the same time in both arms, and
  the probed concepts of both arms are equally active ones. Both are tested.
- More turns are probed: every drawn turn with any candidate, not only two-arm turns
  (66 against 48 at 2 hops on the dev turns).
- **Held-out probes are now about one in five, not one in two.** Because more turns
  are probed the held-out arm loses less than that suggests: on the dev turns at 2 hops
  it would collect 14.3 probes where the earlier rule collected 24 (60 %), and at 1 hop
  18.9 against 20. The taught arm collects about twice what it did. The comparison is
  still limited by the held-out arm, so it needs somewhat longer, or a higher
  `probeRate`, to reach the same number of held-out concepts.

## What is true about balance, and what is not

True, each with a test (`learning-blind-probes.test.ts`):

- **Arm-blind pick.** Which concept is probed does not depend on which concepts are held
  out: with the same graph and turn, the picked concept is the same under any holdout
  set. Whether a turn is probed does not depend on it either.
- **Equal rate per concept.** Each time a concept is a candidate on a probed turn it is
  picked with probability one over the number of candidates, whatever its arm. On the
  fixture graph the two arms' picks per candidate appearance agree within 6 %.
- **Equal timing.** The turn index of a concept's first probe has the same distribution
  in both arms (quartiles within 30 % on the fixture graph, means within 0.01 of the
  run's length in the simulation). Under the earlier rule the taught arm's median first
  probe came more than three times later.
- **Equal selection.** The concepts that have been probed are equally active in both
  arms (mean candidate appearances within 5 % on the fixture; centrality 2.09 against
  2.05 in the simulation, where the earlier rule gave 1.82 against 2.29).
- **No taught-only signal in the candidates.** The candidate rule does not use
  suppression (recently taught or demonstrated), the packet's contents or the review
  queue. A recently taught concept is a candidate like any other.
- **Blind line.** The probe line has the same fields and the instruction the same words
  for both arms.
- **The holdout holds.** A held-out concept is never a task anchor, a prerequisite or a
  review, and never in "Teaching targets" or in the guidance's `conceptIds`. The probe
  line is the only place it appears.
- **Off is byte-identical.** With `blindProbes` off the guidance is what it was.
- **Replay-safe.** Draw and pick are pure functions of the lowercased turn id, and the
  decision is stored once with the injection decision.

Not true, and not claimed:

- **The arms do not get equal numbers of probes.** About one probe in five is a held-out
  one (the held-out share of the candidates), so the held-out arm has about a quarter of
  the taught arm's probes and concepts. The comparison's precision is set by the
  held-out arm.
- **Equal rates are equal in distribution, not for the concepts that happen to be near
  this learner's turns.** On the dev turns (below) the few held-out concepts in range at
  1 hop are near busier turns than the taught ones: 20 held-out concepts would get 18.9
  expected probes (0.94 each) and 77 taught ones 47.1 (0.61 each), and three held-out
  concepts carry 65 % of the held-out picks. At 2 hops it is 0.46 against 0.41 per
  concept and 39 %. That is the luck of which concepts the hash held out, not the rule;
  under the earlier rule the same figures were 1.00 against 0.35 and 0.77 against 0.20.
- **"Held out" is not "never taught".** The holdout started on 2026-10-30. Before that
  date 28 of the 140 held-out concepts were reported taught 71 times. A held-out
  concept is one that has not been a teaching target since then.
- **The concepts in the two arms are not alike in what the learner met before.** The
  hash that picks held-out concepts is blind, but with this few concepts chance
  matters: at 2 hops 34 % of the expected held-out picks against 69 % of the taught
  ones fall on a concept the learner had met (taught, or matched as more than a
  mention) before the holdout started. The analysis splits on it.
- **The agent can sometimes guess.** See "Limits".

## Balance on the real graph and the real turns

The candidate rule (step 4) and the pick (step 6) replayed on the dev graph (664 catalog
concepts, 140 held out, 2,082 edges in `learning_concept_edges`) and every turn with
matches since the holdout started (2026-10-30T18:05Z to 2026-11-11T16:27Z): 66 turns,
all of which have a candidate at every hop distance. Steps 1 to 3, 5 and 8 are not
replayed; they do not look at the arm. Read-only, counts only; no probe was delivered.

| `probeHops` | Turns with candidates in both arms | Only taught | Only held out | Mean candidates per turn (held out / taught) | Held-out share of candidates | Expected held-out probes if all 66 were probed | The pick on these turn ids (held out / taught) | Concepts in range (held out / taught) |
|---|---|---|---|---|---|---|---|---|
| 1 | 40 | 26 | 0 | 1.2 / 2.9 | 30 % | 18.9 | 20 / 46 | 20 / 77 |
| 2 (default) | 48 | 18 | 0 | 2.1 / 6.8 | 23 % | 14.3 | 15 / 51 | 31 / 127 |
| 3 | 48 | 18 | 0 | 2.7 / 9.3 | 23 % | 13.7 | 15 / 51 | 39 / 147 |
| 4 | 49 | 17 | 0 | 3.4 / 12.4 | 21 % | 12.7 | 15 / 51 | 46 / 168 |
| 5 (all) | 58 | 8 | 0 | 40.0 / 134.3 | 23 % | 13.3 | 14 / 52 | 79 / 295 |

- The expected number of held-out probes is the sum over turns of `h / (h + t)`. The
  pick on the actual turn ids agrees with it (15 against 14.3 at the default).
- Under the earlier rule the same turns gave 24 expected held-out and 24 taught probes
  at 2 hops, from the 48 two-arm turns only: 0.77 per held-out concept in range against
  0.20 per taught one, a ratio of 3.8.
- The default stays at 2 hops: it reaches half as many held-out concepts again as 1 hop
  (31 against 20) and spreads the held-out picks over them (see above). "All" draws
  concepts from anywhere in the connected graph (40 held-out candidates per turn),
  which is no longer "related to the turn".
- Volume is small, and smaller for the held-out arm than before. At the default rate of
  20 %, 13 of the 66 turns draw a probe, about 3 of them a held-out one, and only the
  injected ones deliver it: a handful of held-out probes per month at this traffic.
  Raise `probeRate` to collect faster.

The same replay runs as a test on a fixed fixture: the shipped catalog with its real
one-in-five holdout, a sparse hash-built graph, 6,000 turns, at 1 and at 2 hops.

| On the fixture | This rule, 1 hop | 2 hops | Earlier rule, 1 hop | 2 hops |
|---|---|---|---|---|
| Held-out share of probes | 21.3 % | 22.1 % | 49.5 % | 49.3 % |
| Picks per candidate appearance, held out / taught | 0.331 / 0.338 | 0.109 / 0.112 | ratio 3.5 | ratio 3.4 |
| Median turn index of a concept's first probe, held out / taught | 523 / 501 | 426 / 492 | 468 / 2,193 | 270 / 1,051 |
| Mean candidate appearances of the probed concepts, held out / taught | 27.4 / 28.6 | 87.5 / 85.0 | taught 16 % higher | taught 5 % higher |

## Settings

| Key | Type | Default | Meaning |
|---|---|---|---|
| `blindProbes` | boolean | `false` | Master switch. |
| `probeRate` | 0–100 in steps of 20 | `20` | Percent of turns that draw a probe (step 1). Fewer are delivered. |
| `probeHops` | 1–5, 5 = all | `2` | Hop distance for candidates. Independent of `reviewHops`. |

All three live in the single `learning_policy_settings` row and are edited in the web
policy panel.

## What is stored

On `learning_live_feedback_turns`, written once with the injection decision. All null on
turns decided with probes off.

| Column | Meaning |
|---|---|
| `probe_outcome` | `delivered`, or why not: `not_drawn`, `no_target`, `packet_full`, `arm_empty`, `size`, `not_injected`; `fail_open` when the guidance lookup failed and nothing was decided (a successful retry replaces it) |
| `probe_arm` | the arm of the concept the pick fell on, `held_out` or `taught`; set on every drawn turn that had a candidate, delivered or not; null on `arm_empty` |
| `probe_held_out_candidates`, `probe_taught_candidates` | candidates in each arm; set on every drawn turn. Their sum is what the pick chose from |
| `probe_rate`, `probe_hops` | the settings the decision was made under |
| `probe_concept_id` | the probed concept; set exactly when the outcome is `delivered` |
| `probe_concept_hops` | that concept's own distance from the turn's concepts (the graph is not versioned) |
| `guidance_concept_ids` | the teaching targets the guidance carried on this turn (empty when not injected); stored whether probes are on or off, from migration 0028 |
| `guidance_context` | the guidance text the turn delivered, probe line included (null when not injected, and on turns decided before migration 0038); a retried submission answers this text |

The table enforces the shape (migrations 0025 and 0030): a concept is stored exactly on
a delivered probe, the concept's distance only on a delivered probe, and a `fail_open`
row carries no arm, no counts and no concept.

No row was stored under the earlier rule: probes have never been switched on on dev
(checked 2026-11-11: `blindProbes` is false and all 1,529 rows of
`learning_live_feedback_turns` have a null `probe_outcome`). So the change of rule needs
no data migration and no column changed. If probes had been delivered under both rules,
the two sets would have to be analysed apart: the stored arm of an old row came from a
coin, and its candidates were picked from one arm only.

When several reasons apply the first in the order of "The rule" is stored. A turn that
never submits feedback stores nothing; that happens before any draw.

## Restarts

A restart of the API at any instant leaves a turn with one decision, one probe record and one
delivered text (docs/operations/restart-safety.md). The key is the turn id.

| Step | Where it runs | What makes it happen once | After a kill |
| --- | --- | --- | --- |
| Selection (the draw, the candidates, the pick) | inside the submit request | a pure function of the turn id, the graph and the settings; nothing is written | nothing to recover |
| Decision and delivery | inside the submit request | one `UPDATE` claims the turn (`injected IS NULL`) and stores, together, the injection decision, the probe columns, the targets and the text (`guidance_context`); the reply is that stored row | the hook's retry reads the stored row and answers it. It recomputes nothing, so settings or scores that moved in between, or a lookup that fails on the retry, cannot make the reply differ from the record. A kill before the claim leaves `injected` null and the retry decides. If nobody retries, the user's next prompt (any session) closes every submitted turn still undecided after 60 seconds as not injected, so a later retry answers "no intervention" and no turn stays undecided |
| Recording the answer | inside the next turn's submit request | the feedback is written by one `UPDATE` claimed by `feedback IS NULL`; a retry with the same feedback is a no-op and a different one is refused | the retry writes it |
| Grading the answer | the mastery grader's durable workflow (docs/operations/restart-safety.md) | that workflow's own claims | that workflow's recovery; not part of this feature |
| GrowthBook | GrowthBook reads `learning_blind_measurements` with its read-only role | a pure read; the server pushes nothing | nothing to recover |

Nothing here outlives the request, holds a lease or waits for a person. A failed or killed request
leaves `injected` null (with `fail_open` when the lookup failed); a retry decides it, and otherwise the
next prompt closes it. The 60 seconds are longer than the hook's own retry window (45 seconds). A turn
closed this way has no probe decision stored: nothing was drawn for it.

One limit. A turn injected before migration 0038 has no stored text; a retry of such a turn answers
"no intervention". The hook retries within seconds, so this covers only a retry that straddles the
migration.

The test is `packages/runtime-pikku/tests/probe-delivery-restart.test.ts`: a real API process is
killed while its decision statement is held on a lock. In one case the statement then commits with
no process left to answer, the settings are changed to probes off and no injection, and the retry
must still deliver the recorded probe; in the other the statement is aborted and the retry decides
once. Both run with SIGKILL and with SIGTERM, each signal at both instants. It fails when the retry recomputes the text, and
when the claim is removed.

A delivery is confirmed by the hook. It records a `submission` trace (`learning_feedback_traces`) only
after it has read the reply, and keeps the trace in its outbox while the API is down. A decision that
is still unconfirmed one hour after its submission never reached the agent: the process died before
replying and the hook's retries ran out. The user's next prompt withdraws it: the turn is stored as not
injected, its probe as `not_injected` with no concept, and its review and text are cleared, so the next
turn is not read as the answer to a probe that was never asked. Only a decision with a stored
text is withdrawn, so rows decided before migration 0038 and seeded fixture rows are left alone. On dev every injected turn so far has
its trace (112 of 112), none later than an hour. Until that next prompt a lost delivery still reads as
delivered; a confirmed trace that arrives more than an hour late (the hook kept it in its outbox that
long and the user sent a prompt first) loses that probe. Both are rare and do not depend on the arm.

## What a probe changes later, and what it does not

An answered probe shows up in a later turn's matches. Teaching and review exist for
taught concepts only, so anything a probe answer changes there changes one arm.

Closed, each with a test that fails when the exclusion is removed. One definition is
used everywhere: a **probe answer** is what the learner says on the turn right after the
probe turn, in the same session, about the probed concept. Nothing else is hidden: a
later turn of that session, another session, and other concepts on the answer turn are
ordinary evidence.

- **Suppression and gaps.** The live policy does not see the probe answer
  (`readRecentLiveFeedback`), so it neither pauses teaching of the concept nor opens a
  gap.
- **The agent's recent feedback.** The begin packet is built from the same filtered
  view, so the agent is not told about the answer on later turns.
- **Review schedule.** `readReviewHistory` does not count the probe answer as an
  exposure. For the archive side, which has no link to the live session, the answer is
  a message cited by the published assessment and said between the probe turn and two
  minutes after the answer turn was received. A probe with no next turn has no answer
  and hides nothing.
- **Not re-offered.** A probed concept counts as offered for 24 hours, like a delivered
  review, in every session. Without this the concept would be due the moment it was
  probed (its answer is not an exposure) and the next turn would review it, which only
  a taught concept can receive.

Open. These are effects of a probe on later treatment, in the taught arm only:

- **The grade.** The answer is evidence for the mastery grader like any other message
  (that is the point of asking). The grade then steers teaching: a concept graded below
  the prerequisite strictness (60 by default) is an unmet prerequisite, and the grade
  sets the review interval (bands at 20, 40, 60 and 80). So a taught concept answered
  well can stop being taught as a prerequisite and be reviewed later; one answered
  badly, the reverse. A held-out concept's grade moves too, but nothing is taught from
  it. Size: at most one concept per taught-arm probe, so about four in five delivered probes, and
  only when the new grade crosses one of those lines. It is not closed because the
  grader reads archive messages, and separating "said in answer to a probe" from the
  rest there is not cheap.
- **Hidden evidence.** A real misconception shown in the probe answer is hidden from
  the live policy with the answer, so the remedial teaching it would have triggered
  waits until the learner shows it again. One turn, one concept.
- **Teaching reported by the agent.** If the agent lists the probed concept in
  `taughtConceptIds`, that is teaching and is treated as teaching.
- **The review schedule.** Because the answer is not an exposure, the concept is as due
  after the probe as it was before it, minus the 24 hours in which it is not offered.
  Nothing else is hidden from the schedule any more: every other match and message
  counts, in every session, and the live-match and cited-message rules now cover the
  same thing (the answer turn of the probe's own session).

What the analysis below does about these. It scores the answer turn only, which comes
before any treatment that follows that probe. That keeps a probe's own consequences out
of its own score. It does not keep them out of the NEXT probe of the same concept: a
taught concept answered well at its first probe may have been graded up and dropped as
a prerequisite before its second, which cannot happen to a held-out concept. Both arms'
concepts have been asked equally often before (the pick sees to that), so practice at
answering is balanced; the change in teaching is not. So only a concept's first probe
is free of what earlier probes did, and the headline difference is the first-probe one
for that reason ("The headline difference").

## Analysis

Everything here is in `learning-blind-probes.ts` and tested in
`learning-blind-probes.test.ts` (the arithmetic, against hand-computed figures, and the
interval's coverage on a simulated learner) and
`learning-spaced-repetition-db.test.ts` (the SQL). Parameters of every query: the user
id and the start of the holdout (`HOLDOUT_STARTED_AT`). Probes delivered before that
date are left out and do not count towards a concept's probe index.

`bun --env-file=/etc/learner/db.env scripts/measurement-report.ts` prints all of it,
read-only, with each arm's exposure (`probeExposure`, see "Limits") and the statement
that one learner's figures are descriptive. Nothing in the app shows it yet.

### How a probe is scored

- **The answer turn only.** A probe is scored on the session's next turn and nowhere
  else. From the turn after that the server may teach the probed concept (it stays
  teachable on purpose), and only a taught concept can be taught, so a longer window
  would credit the taught arm with teaching that followed the question.
- **`demonstrated`**: a `learner_evidence` match for the probed concept with outcome
  `demonstrated`. The outcome of the comparison.
- **`answered`**: the learner said something about the concept, right or wrong
  (`learner_evidence` or `misconception`). It is the blindness check, so it must count
  any answer. If only correct-leaning evidence counted, teaching that removes
  misconceptions would raise the taught arm's `answered` and read as unblinding.
- **Probes that are not scored**, counted per arm by reason. `no_answer`: there is no
  next turn, or it was begun and its feedback never submitted (1 of 259 turns since
  the holdout began). The arm cannot cause that except through the agent's behaviour.
  `explained`: the answer turn lists the concept in `taughtConceptIds`, so the agent
  explained instead of asking. That one can depend on the arm (an agent is likelier to
  explain what it has been teaching), so it is reported per arm and the headline is
  given again with those probes scored both ways.
- Turns are ordered by the time they began, then by turn id, so two turns begun at the
  same instant still have one order.

### The headline difference

`probeDifference(rows, { reading })` on the rows of `PROBE_ROWS_SQL` (one per delivered
probe). Three readings:

| `reading` | What is compared | Role |
|---|---|---|
| `first` (default) | each concept's first probe since the holdout started, every concept counting once | **the headline** |
| `all` | every scored probe, weighted by the turn's candidate count, a concept's probes as one cluster | sensitivity |
| `concept` | each concept once, with its mean over all its scored probes | sensitivity |

| Field | Meaning |
|---|---|
| `reading` | which of the three |
| `status` | `ok`, or `not_enough_data`: no stratum has 2 concepts with a scored probe in each arm (`PROBE_MIN_CONCEPTS_PER_ARM`). Every figure is then null |
| `difference` | taught minus held-out share demonstrated |
| `se`, `df`, `interval` | its standard error (never 0), the degrees of freedom, and the 95 % t interval from the two |
| `strata`, `strataDropped` | `met_before` strata compared; strata left out for having fewer than 2 concepts in an arm |
| `delivered`, `probes`, `concepts` | per arm, in the compared strata: probes of this reading, the scored ones among them, and their concepts |
| `unscored` | per arm, in the compared strata: probes with no answer and probes explained. `delivered` = `probes` + both + `missingWeight` |
| `missingWeight` | reading `all` only: scored probes stored without a candidate count. They are left out, not weighed as one |
| `deliveredInDroppedStrata` | per arm: probes of this reading in a stratum that was not compared |
| `ifExplained` | `difference` again with every explained probe scored as not demonstrated, then as demonstrated |
| `daysGap` | mean days since the holdout began, taught minus held-out, with the same weights, over scored probes. About 0 in expectation under this rule |
| `priorProbesGap` | mean number of earlier probes of the same concept behind a scored probe, taught minus held-out, with the same weights. 0 for `first`; about 0 in expectation for the others under this rule |

Why the first probe is the headline:

- **A probe changes what happens to the concept next, in one arm only.** Its answer is
  graded and the grade steers later teaching, which only a taught concept receives (see
  "What a probe changes later"). The first probe is the only one with no earlier probe
  behind it. Practice at answering, the other thing a repeat probe carries, is now
  balanced: both arms' concepts are asked equally often, and `priorProbesGap` on the
  two sensitivity readings checks that it was.
- **Probe and concept coincide.** One probe per concept, so there is no choice of unit,
  no weight and no within-concept correlation: the comparison is a two-sample one over
  concepts.
- **What it costs.** A concept whose first probe was not scored (no answer, or
  explained) is not in the headline even if a later probe was scored; `unscored` counts
  them and `ifExplained` bounds the explained ones. Repeat probes add nothing, so the
  headline stops improving once most concepts near the conversation have been probed
  once: its precision is set by the number of held-out concepts, not of probes.
- **Centrality and timing are balanced by the scheduler, not by the analysis.** A
  concept related to more turns is probed sooner and is more likely to have a first
  probe at all. That is equally so in both arms now, so the probed concepts of the two
  arms are equally central and their first probes equally late. Under the earlier rule
  neither held, and the headline leaned towards the taught arm with no teaching effect
  (simulated, below). `daysGap` reports the timing that was actually realized: it should
  be near zero, and a difference with a large `daysGap` is confounded with time, by
  chance or because the rule was changed.

How every reading is computed:

- **Strata: `met_before` only.** Whether the concept was taught or matched (not a bare
  mention) before the holdout started. It is fixed before the holdout, and the arms
  have different shares of it. A stratum's weight is the number of concepts in its
  smaller arm. The probe index is NOT a stratum: which concepts reach a second or
  third probe depends on the arm.
- **Standard error: concepts are clusters.** Within a stratum each arm's rate is a
  weighted mean over concepts. Its variance is the cluster-robust one with each
  concept's squared residual divided by one minus that concept's share of the arm's
  weight (the leverage adjustment known as CR2). With one probe per concept and equal
  weights, the headline's case, that is exactly `s² / n`, so the standard error is
  Welch's. The earlier `G / (G - 1)` factor is the same thing for equal weights and
  about 10 % too small for the unequal weights of the `all` reading.
- **No spread is not no error.** An arm whose concepts all gave the same answer has a
  sample variance of 0. Its variance is floored at `p(1 - p) / (m + 2)` with
  `p = (successes + 1) / (m + 2)`: what `m` independent probes would give with one
  success and one failure added. `m` is the arm's effective number of probes,
  `(Σw)² / Σw²` (for the headline, its number of concepts). So `se` is never 0 and an
  `ok` result always has an interval of positive width.
- **Degrees of freedom.** Each arm has its effective number of concepts,
  `(Σw)² / Σw²` over concept clusters, minus one (for the headline, `n - 1`). They are
  combined by Welch-Satterthwaite. With the few held-out concepts expected, `df` is
  small and the t interval is much wider than ±2 `se`; use `interval`, not `se`.
- **Independence.** A concept belongs to one arm and one stratum, so the pieces are
  independent and their variances add. Sessions are not clusters: a session delivers
  few probes and the concept, not the session, carries the ability.
- **Not enough data.** With one concept in an arm there is no spread to estimate, so
  the stratum is not compared, and with no stratum left nothing is reported.

The two sensitivity readings and what they are for:

- `all` weights a probe by the number of candidates on its turn
  (`probe_held_out_candidates + probe_taught_candidates`), the inverse of its chance of
  being the pick, so both arms estimate "the demonstrated rate of a candidate concept
  on a probed turn". The weight does not depend on the arm. It uses every scored probe
  and is the most precise reading.
- `concept` answers "for an average probed concept, over all its probes".
- **Neither is pulled by practice at answering any more**, because the arms' probes have
  the same number of earlier probes behind them (simulated below: the `all` reading's
  bias under a testing effect went from -0.102 to +0.015 at 300 probes). They still pool
  probes that come after a probe's answer changed the teaching of a taught concept, so
  they are not alternatives to the headline. If they sit away from it, look at
  `priorProbesGap` first: it should be near zero, and if it is, the gap between the
  readings is what earlier probes did to later teaching, or chance.
- **`all` has a small bias of its own when central concepts are the better known ones**:
  about +0.01 to +0.02 with 24 held-out concepts in the simulation. It is the bias of a
  weighted mean over few clusters (the held-out arm has a quarter of the taught arm's
  concepts), not of the schedule: it does not shrink with more probes and it does with
  more concepts (+0.015 at 120 concepts, +0.003 at 600, same probes per concept). The
  unweighted headline does not have it.

Report the headline with its `interval`, both concept counts, the unscored counts,
`ifExplained`, `daysGap`, and the two sensitivity readings with their `priorProbesGap`
beside it. `scripts/measurement-report.ts` prints exactly that.

### How the analysis was checked

`learning-blind-probes.simulation.ts` simulates a learner under the production rule
(120 concepts with log-normal centrality, one in five held out, half met before; a turn
relates about eleven concepts in proportion to centrality and picks one of them
uniformly, whatever its arm). The rows marked "earlier rule" below were printed by the
simulation of the earlier rule in commit 829754b; that code is removed, so the script no
longer prints them. `probeCoverage` runs `probeDifference` on it many times and `probeSchedule`
reports when and which concepts are probed, by arm. `topicBoost` and `topicFeedback`
make the turns' topics depend on the arm; their results are under "Limits". `bun scripts/probe-simulation.ts`
prints both tables below (2,000 replications per row, seed 20261111; the schedule
table 400); the fixed-seed tests in `learning-blind-probes.test.ts` hold the no-effect,
testing, trend-and-centrality and schedule results in place.

"Bias" is the mean difference minus the true effect; "coverage" the share of 95 %
intervals that hold the true effect; "excludes 0" the share of intervals that exclude
zero, which is the false-positive rate when the true effect is 0. "Runs compared" is
how many of the 2,000 runs had two scored concepts per arm in some stratum; the rates
are over those.

| World | Probes | Runs compared | `first`: bias | spread / mean se | coverage | excludes 0 | `all`: bias | spread / mean se | coverage | excludes 0 | `concept`: bias | coverage | excludes 0 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| no effect | 30 | 1835 | +0.002 | 0.293 / 0.298 | 95.9 % | 4.1 % | +0.002 | 0.277 / 0.274 | 96.7 % | 3.3 % | +0.004 | 96.3 % | 3.7 % |
| no effect | 60 | 1985 | -0.002 | 0.218 / 0.219 | 95.9 % | 4.1 % | -0.001 | 0.190 / 0.193 | 97.1 % | 2.9 % | -0.001 | 96.2 % | 3.8 % |
| no effect | 120 | 1999 | -0.006 | 0.172 / 0.169 | 95.2 % | 4.8 % | 0.000 | 0.141 / 0.138 | 95.4 % | 4.6 % | -0.004 | 95.1 % | 4.9 % |
| no effect | 300 | 2000 | +0.003 | 0.136 / 0.138 | 95.7 % | 4.3 % | +0.004 | 0.098 / 0.096 | 94.9 % | 5.1 % | +0.002 | 95.7 % | 4.3 % |
| no effect, ability rises with centrality | 30 | 1835 | +0.008 | 0.292 / 0.301 | 96.2 % | 3.8 % | +0.014 | 0.274 / 0.278 | 96.7 % | 3.3 % | +0.009 | 96.4 % | 3.6 % |
| no effect, ability rises with centrality | 60 | 1985 | -0.001 | 0.221 / 0.220 | 95.6 % | 4.4 % | +0.008 | 0.199 / 0.194 | 96.0 % | 4.0 % | -0.001 | 95.7 % | 4.3 % |
| no effect, ability rises with centrality | 120 | 1999 | -0.005 | 0.173 / 0.170 | 95.1 % | 4.9 % | +0.009 | 0.146 / 0.141 | 95.2 % | 4.8 % | -0.006 | 94.8 % | 5.2 % |
| no effect, ability rises with centrality | 300 | 2000 | +0.002 | 0.137 / 0.138 | 95.0 % | 5.0 % | +0.015 | 0.102 / 0.101 | 95.2 % | 4.8 % | +0.001 | 96.0 % | 4.0 % |
| no effect, testing effect 0.3 per probe | 30 | 1835 | +0.002 | 0.293 / 0.298 | 95.9 % | 4.1 % | +0.005 | 0.277 / 0.275 | 96.7 % | 3.3 % | +0.003 | 96.5 % | 3.5 % |
| no effect, testing effect 0.3 per probe | 60 | 1985 | -0.002 | 0.218 / 0.219 | 95.9 % | 4.1 % | +0.005 | 0.193 / 0.193 | 96.7 % | 3.3 % | -0.002 | 96.0 % | 4.0 % |
| no effect, testing effect 0.3 per probe | 120 | 1999 | -0.006 | 0.172 / 0.169 | 95.2 % | 4.8 % | +0.008 | 0.144 / 0.140 | 95.1 % | 4.9 % | -0.005 | 95.1 % | 4.9 % |
| no effect, testing effect 0.3 per probe | 300 | 2000 | +0.003 | 0.136 / 0.138 | 95.7 % | 4.3 % | +0.015 | 0.100 / 0.098 | 95.8 % | 4.3 % | +0.001 | 96.1 % | 3.9 % |
| no effect, testing 0.3 and centrality | 30 | 1835 | +0.008 | 0.292 / 0.301 | 96.2 % | 3.8 % | +0.018 | 0.274 / 0.279 | 96.5 % | 3.5 % | +0.010 | 96.3 % | 3.7 % |
| no effect, testing 0.3 and centrality | 60 | 1985 | -0.001 | 0.221 / 0.220 | 95.6 % | 4.4 % | +0.011 | 0.201 / 0.194 | 95.7 % | 4.3 % | -0.001 | 96.0 % | 4.0 % |
| no effect, testing 0.3 and centrality | 120 | 1999 | -0.005 | 0.173 / 0.170 | 95.1 % | 4.9 % | +0.015 | 0.148 / 0.142 | 95.6 % | 4.4 % | -0.006 | 95.1 % | 4.9 % |
| no effect, testing 0.3 and centrality | 300 | 2000 | +0.002 | 0.137 / 0.138 | 95.0 % | 5.0 % | +0.021 | 0.106 / 0.102 | 94.8 % | 5.1 % | -0.001 | 95.1 % | 4.9 % |
| no effect, learning trend +1 logit over the run | 30 | 1835 | +0.015 | 0.288 / 0.302 | 96.9 % | 3.1 % | +0.014 | 0.273 / 0.278 | 97.3 % | 2.7 % | +0.015 | 97.3 % | 2.7 % |
| no effect, learning trend +1 logit over the run | 60 | 1985 | -0.001 | 0.221 / 0.220 | 95.9 % | 4.1 % | -0.004 | 0.192 / 0.192 | 96.5 % | 3.5 % | -0.002 | 96.3 % | 3.7 % |
| no effect, learning trend +1 logit over the run | 120 | 1999 | -0.002 | 0.174 / 0.170 | 95.2 % | 4.8 % | +0.001 | 0.143 / 0.138 | 95.3 % | 4.7 % | -0.002 | 95.3 % | 4.7 % |
| no effect, learning trend +1 logit over the run | 300 | 2000 | +0.005 | 0.137 / 0.139 | 94.7 % | 5.3 % | +0.004 | 0.098 / 0.097 | 95.5 % | 4.5 % | +0.001 | 95.5 % | 4.5 % |
| no effect, trend +1 and centrality | 30 | 1835 | +0.007 | 0.289 / 0.295 | 96.6 % | 3.4 % | +0.013 | 0.268 / 0.271 | 97.5 % | 2.5 % | +0.008 | 96.8 % | 3.2 % |
| no effect, trend +1 and centrality | 60 | 1985 | 0.000 | 0.214 / 0.216 | 96.0 % | 4.0 % | +0.007 | 0.189 / 0.188 | 97.1 % | 2.9 % | 0.000 | 96.4 % | 3.6 % |
| no effect, trend +1 and centrality | 120 | 1999 | -0.005 | 0.168 / 0.168 | 95.5 % | 4.5 % | +0.009 | 0.138 / 0.136 | 96.0 % | 4.0 % | -0.004 | 95.8 % | 4.2 % |
| no effect, trend +1 and centrality | 300 | 2000 | +0.003 | 0.137 / 0.138 | 95.0 % | 5.0 % | +0.014 | 0.098 / 0.097 | 95.2 % | 4.9 % | +0.001 | 95.4 % | 4.6 % |
| true effect 0.15 | 30 | 1835 | +0.003 | 0.294 / 0.298 | 95.5 % | 6.6 % | +0.005 | 0.277 / 0.274 | 96.5 % | 6.4 % | +0.005 | 96.0 % | 6.9 % |
| true effect 0.15 | 60 | 1985 | -0.002 | 0.217 / 0.219 | 96.1 % | 8.7 % | 0.000 | 0.190 / 0.192 | 97.4 % | 9.3 % | -0.001 | 96.7 % | 9.2 % |
| true effect 0.15 | 120 | 1999 | -0.007 | 0.170 / 0.169 | 95.9 % | 12.2 % | 0.000 | 0.140 / 0.138 | 95.2 % | 16.1 % | -0.004 | 95.3 % | 15.7 % |
| true effect 0.15 | 300 | 2000 | +0.003 | 0.135 / 0.137 | 95.6 % | 18.1 % | +0.003 | 0.099 / 0.096 | 95.3 % | 29.1 % | +0.001 | 95.5 % | 27.3 % |
| true effect 0.15, testing 0.3 per probe | 30 | 1835 | +0.003 | 0.294 / 0.298 | 95.5 % | 6.6 % | +0.008 | 0.275 / 0.274 | 96.8 % | 6.3 % | +0.005 | 95.9 % | 6.4 % |
| true effect 0.15, testing 0.3 per probe | 60 | 1985 | -0.002 | 0.217 / 0.219 | 96.1 % | 8.7 % | +0.004 | 0.193 / 0.192 | 96.7 % | 8.6 % | -0.002 | 96.3 % | 9.3 % |
| true effect 0.15, testing 0.3 per probe | 120 | 1999 | -0.007 | 0.170 / 0.169 | 95.9 % | 12.2 % | +0.006 | 0.142 / 0.138 | 95.2 % | 16.1 % | -0.006 | 95.0 % | 14.6 % |
| true effect 0.15, testing 0.3 per probe | 300 | 2000 | +0.003 | 0.135 / 0.137 | 95.6 % | 18.1 % | +0.011 | 0.098 / 0.097 | 95.9 % | 30.4 % | 0.000 | 96.2 % | 24.3 % |
| **earlier rule**, no effect, trend +1 and centrality | 30 | 1999 | +0.034 | 0.239 / 0.232 | 95.3 % | 4.7 % | +0.007 | 0.221 / 0.213 | 95.3 % | 4.7 % | +0.019 | 95.3 % | 4.7 % |
| **earlier rule**, no effect, trend +1 and centrality | 60 | 2000 | +0.043 | 0.181 / 0.180 | 95.0 % | 5.0 % | +0.007 | 0.156 / 0.154 | 95.5 % | 4.5 % | +0.025 | 95.2 % | 4.8 % |
| **earlier rule**, no effect, trend +1 and centrality | 120 | 2000 | +0.057 | 0.156 / 0.149 | 92.7 % | 7.3 % | +0.011 | 0.117 / 0.115 | 95.1 % | 4.9 % | +0.034 | 93.0 % | 7.0 % |
| **earlier rule**, no effect, trend +1 and centrality | 300 | 2000 | +0.052 | 0.131 / 0.129 | 92.8 % | 7.1 % | +0.007 | 0.088 / 0.084 | 93.8 % | 6.2 % | +0.025 | 93.6 % | 6.4 % |
| **earlier rule**, no effect, testing 0.3 per probe | 30 | 1999 | 0.000 | 0.240 / 0.235 | 95.5 % | 4.5 % | -0.030 | 0.225 / 0.217 | 95.2 % | 4.8 % | -0.019 | 95.3 % | 4.7 % |
| **earlier rule**, no effect, testing 0.3 per probe | 60 | 2000 | -0.001 | 0.182 / 0.181 | 95.6 % | 4.4 % | -0.053 | 0.158 / 0.158 | 95.0 % | 5.1 % | -0.032 | 94.8 % | 5.3 % |
| **earlier rule**, no effect, testing 0.3 per probe | 120 | 2000 | 0.000 | 0.153 / 0.149 | 95.0 % | 5.0 % | -0.079 | 0.116 / 0.119 | 91.5 % | 8.5 % | -0.047 | 93.5 % | 6.5 % |
| **earlier rule**, no effect, testing 0.3 per probe | 300 | 2000 | -0.003 | 0.128 / 0.128 | 95.5 % | 4.5 % | -0.102 | 0.084 / 0.084 | 79.7 % | 20.3 % | -0.079 | 85.5 % | 14.4 % |

The schedule, with no outcome involved (300 probes; at 60 the picture is the same):

| Rule | Arm | Probes per probed concept | A concept's first probe, mean share of the run | Quartiles | Mean centrality of the probed concepts |
|---|---|---|---|---|---|
| this rule | held out | 3.52 | 0.315 | 0.09 / 0.23 / 0.48 | 2.09 |
| this rule | taught | 3.44 | 0.316 | 0.09 / 0.24 / 0.49 | 2.05 |
| earlier rule | held out | 7.08 | 0.224 | 0.05 / 0.14 / 0.33 | 1.82 |
| earlier rule | taught | 2.58 | 0.355 | 0.12 / 0.29 / 0.55 | 2.29 |

What the tables say:

- With no effect of any kind, all three readings are unbiased and their intervals hold
  zero about 95 % of the time at every size, and no replication has a zero error.
- **The headline is unbiased in every no-effect world**: ability rising with
  centrality, a testing effect, a learning trend of +1 logit over the run, and the trend
  with centrality together. The largest bias is +0.015 (at 30 probes, within the noise
  of 2,000 runs) and at 60 probes and more it is within ±0.006. Under the earlier rule
  the trend with centrality gave +0.03 to +0.06 and a false-positive rate of 7 % at 120
  and 300 probes (the last block but one), and it did not shrink with more probes.
- A testing effect (each earlier probe of a concept adds 0.3 to its log-odds) no longer
  moves the `all` and `concept` readings: both arms' concepts have been asked equally
  often. Under the earlier rule `all` fell to -0.10 at 300 probes and its interval
  excluded zero in one run in five (the last block).
- `all` carries +0.01 to +0.02 whenever ability is tied to how often a concept is
  probed (the centrality and testing worlds). See "The two sensitivity readings".
- **The price is precision at small sizes.** The held-out arm now gets one probe in
  five, so the headline's standard error is 0.30 at 30 probes and 0.22 at 60, against
  0.24 and 0.18 under the earlier rule; at 300 probes it is 0.14 against 0.13, because
  by then most held-out concepts near the turns have had their first probe under either
  rule. Power for a true effect of 0.15 is 7 to 18 % for the headline (earlier 9 to
  20 %) and 6 to 29 % for `all` (earlier 9 to 38 %).
- At 30 probes 165 of 2,000 runs (8 %) have fewer than two scored concepts in an arm
  of every stratum and give no result; at 60 probes 15, at 120 one, at 300 none. Under
  the earlier rule it was one run at 30 probes. Thirty delivered probes hold about six
  held-out ones, so nothing should be read before roughly 60.

### The descriptive table

`PROBE_ANALYSIS_SQL`: one row per arm, `met_before` and `probe_index` (`1`, `2`, `3+`).
It shows what was probed; it is not a comparison (see the note on the probe index
above).

| Column | Meaning |
|---|---|
| `concepts` | concepts with at least one scored probe in the row |
| `probes`, `no_answer_probes`, `explained_probes` | scored probes; probes not scored, by reason |
| `answered`, `demonstrated` | mean over concepts of each concept's share of scored probes |
| `sd_demonstrated` | standard deviation of that share across concepts |
| `days_since_holdout` | mean days from the holdout start to the scored probes |

Also:

- **`probe_hops`.** The setting is per turn, so it is the same for both arms, but
  changing it changes the candidate pool and how often each concept is probed. Keep
  it fixed for a run; if it was changed, analyse each value of the stored `probe_hops`
  separately.
- **With randomized injection on** nothing changes here. A probe needs an injected
  turn, and the injection coin does not know the arm. See
  [randomized-injection.md](randomized-injection.md) for what changes there.

Reading it:

- `answered` should be about equal across arms. If it is not, the probe is not blind
  in practice and `demonstrated` is not a fair comparison.
- Check the pick on the stored draws. The held-out probes should be close to the sum
  of each drawn turn's held-out share of candidates:
  `SELECT count(*) FILTER (WHERE probe_arm = 'held_out') AS held_out, round(sum(probe_held_out_candidates::numeric / (probe_held_out_candidates + probe_taught_candidates)), 1) AS expected, count(*) AS drawn FROM learning_live_feedback_turns WHERE probe_arm IS NOT NULL`.
- The outcome is tagged by the coding agent that asked the question. It does not know
  the arm, but see "Limits" on guessing.
- The mastery view does not use this rule yet: it marks a reading as a probe answer
  when its evidence falls within 24 hours after a probe, which can include teaching
  that followed the probe (taught arm only). `probeAnswerEvidenceSql` is the rule it
  should use. Until it does, do not read the mastery view's probe estimate.

### Sensitivity: could the agent tell the arm?

`PROBE_LEAK_SQL` gives the comparison split by `seen_in_session`: the agent already had
the concept in this session when it asked. Either an earlier turn delivered it as a
teaching target (`guidance_concept_ids`) or a review, or a turn up to and including the
probe turn reported it taught. The probe turn counts for the report because a turn's
`taughtConceptIds` describe the agent's reply before it, which here is the reply right
before the question. For a taught concept that is how the agent could guess the arm. For a held-out
concept it is contamination: the agent taught it unasked.

It is a sensitivity reading, not a filter. Only a taught concept can be a teaching
target, so dropping `seen_in_session` probes would be a rule one arm triggers. Report
the arms' difference with and without those probes; if it moves, say so.

## One learner is not a sample

The comparison of the arms for one learner is a description, not a test, and no screen
or report may print a verdict from it. A verdict on whether teaching works belongs to
the pooled analysis over many learners (GrowthBook, `mastery-holdout-growthbook.ts`)
and nowhere else. The figures behind that, measured on the main learner's dev data over
the first 12 days of the holdout (review 7, S3):

| | |
|---|---|
| Injected turns (a probe goes out only on one) | 38 in 12 days |
| Delivered probes at `probeRate` 20 | at most about 17.6 a month, before the `no_target`, `packet_full` and `size` rules |
| Of them held-out probes (23 % of candidates at 2 hops) | at most about 4 a month |
| Held-out concepts with a prior-blind baseline, which the mastery headline needs | 12 of 140; 5 of the 31 in range so far (taught: 27 of 127) |
| Usable held-out units for the mastery headline, after the 64 % lost to low-confidence readings | about 0.25 a month, 12 at the very most; the 20-per-arm minimum cannot be reached |
| This spec's probe-only comparison (`probeDifference`, no baseline needed) | 5 months or more to 20 held-out concepts, before no-answer and explained probes are taken off |
| What 20 held-out concepts would give | a standard error of about 0.125 on a share: a 95 % interval of about ±0.25 |
| Chance in the schedule itself | the held-out over taught probe rate of one learner has a 95 % range of 0.36 to 2.16 at 1 hop |

So for one person the numbers of this spec say what was asked and what was answered.
They can show that something is badly off (probes not blind, an arm never probed);
they cannot show that teaching worked. Raising `probeRate` to 100 gives about five
times the probes and the same ceiling on held-out concepts with a baseline. The report
script and the policy dialog say this in their own words, and the `getHoldoutEffect`
description does.

## Limits and what is left

- The server controls the instruction, not the agent's behaviour. Whether the agent asks
  exactly one question and does not teach is not verified live. No live turn has been
  probed yet: the switch is off.
- The arm can sometimes be guessed from the session. A taught concept may have been a
  "Teaching targets" entry earlier in the same session; a held-out concept never was.
  The agent is not told about arms, and the question is a fixed template, but the agent
  also tags the answer, and it remembers what it explained. Measured on the replay's 66
  turns at 2 hops: 7 % of the taught arm's pick weight falls on a concept the session
  had already reported taught or reviewed, against 1 % for the held-out arm. The taught
  figure is a lower bound, because teaching targets were not stored for most of those
  turns; they are now (`guidance_concept_ids`), and `PROBE_LEAK_SQL` reports the split. Such concepts are
  not excluded: that would again be a rule only taught concepts can trigger.
- The picked concept is one the packet was about to teach on 4 of those 66 turns (6 %).
  It is then probed instead of taught on that turn.
- A probe is itself an exposure, and answering it can teach. Held-out and taught
  concepts are now probed equally often, so a high `probeRate` wears the holdout down
  no faster than it adds practice to the taught arm, but it still does: every probe of
  a held-out concept is a question about something that was meant to be left alone.
- With about 31 held-out concepts in range of the turns so far, and one probe in five
  going to them, the comparison has few units and collects them slowly. Expect wide
  intervals until many more concepts have been probed; more probes of the same concepts
  do not narrow the headline.
- Three biases of the earlier rule are removed by the scheduler and are no longer
  limits of the headline: central concepts being the better known ones (was about
  +0.03), the learner getting better with time while held-out concepts were probed
  earlier (was +0.02 to +0.03, +0.04 to +0.06 with centrality), and held-out concepts
  being asked more often (the testing effect in the sensitivity readings). They are
  removed in expectation. In one learner's data the arms can still differ by chance in
  timing and in how active their probed concepts are (see the 1-hop figures under "What
  is true about balance"), so read `daysGap` against the holdout's length (the report
  script prints both) before the difference.
- **What the scheduler cannot balance: what the conversation is about.** The pick is
  uniform over the candidates, but who is a candidate depends on the turn's concepts,
  and teaching can change those. Two routes, pulling opposite ways:
  - *Direct.* A turn's own concepts are never candidates. A taught concept the
    conversation keeps returning to is a turn concept more often and is probed less.
  - *Indirect.* The same concept being a turn concept makes its neighbours candidates
    more often, and four in five of those neighbours are taught concepts.

  Neither shows in the fixture or in the first simulation, where the turns' topics do
  not know the arm. `topicFeedback` (in the simulation module) runs the real
  `selectProbe` on a random graph over the real catalog and holdout with topics that do:
  a taught neighbour of a turn's topic is taught with chance 0.3 and is from then on a
  topic with extra weight `boost`. Held-out over taught probes per concept, relative to
  the same seed with no feedback (12 seeds, 3,000 turns): 0.90 at 1 hop with boost 2
  (every seed below 1, from 0.79 to 0.97), 0.97 at 2 hops (seeds from 0.86 to 1.14);
  with boost 0.5 it is within noise. So in this model the indirect route wins and the taught arm is probed 5 to
  15 % more; another graph could give the other sign. A test holds the 1-hop figure
  between 0.82 and 0.97 over four seeds.
- **Is the headline biased by it?** Not in the simulation: with a taught concept three
  times as likely to be the turn's own topic (`topicBoost: 2`), with and without the
  centrality link and the time trend, the first-probe bias is within ±0.004 (2,000
  runs) and coverage 94.7 to 96 %. The reason is the same as for centrality: a concept
  that is probed less or later is still scored once, at its first probe. What it can
  do is change WHICH taught concepts have been probed by a given date, and if the
  much-discussed ones are also the better known ones, the taught arm's probed set is
  shifted. That is not simulated, because a concept being discussed more because it was
  taught is part of what teaching does.
- **No exposure adjustment is made to the headline, on purpose.** How often a concept
  is near the conversation is measured after the arm was assigned and can be caused by
  teaching. Adjusting for it would take out a part of the teaching effect and could
  bias the rest. It is reported instead: `probeExposure` (printed by the report script)
  gives, per arm, the expected probes per concept if every turn so far were probed, and
  how often the arm's concepts were a turn's own topic. On the dev turns
  (2026-11-11, 71 turns): 0.108 against 0.107 per concept at 2 hops (ratio 1.02) and
  0.145 against 0.097 at 1 hop (ratio 1.51); own-topic turns 0.19 against 0.17 per
  concept. The 1-hop ratio is chance: permuting the arm labels over the same exposure
  gives a 95 % range of 0.36 to 2.16 (review 7). Read the ratio beside the headline; a
  ratio far from 1 that grows as teaching accumulates is this route, not luck.
- The candidate ids of a turn are not stored and the graph is not versioned, so the
  exposure is recomputed from the turns' concepts and the edges as they are on the day
  of the report. After a large change of the graph it describes the new graph, not the
  one the probes were drawn on.
- The mastery-holdout statistics (`mastery-change*.ts`, the GrowthBook SQL) read the
  same probes; their time adjustment and known-truth tests are their own
  ([mastery-change-statistics.md](mastery-change-statistics.md)).
- With two or three held-out concepts compared, the degrees of freedom are about 2 and
  the 95 % interval is wider than the possible range of a difference of shares. The
  result keeps the interval as computed; `probeIntervalText` (used by the report script)
  clips what is printed to [-1, 1] and prints "uninformative" below 2 degrees of freedom.
- The two sensitivity readings pool repeat probes, including those that follow a change
  of teaching caused by an earlier probe's answer, and `all` has a small-sample bias of
  +0.01 to +0.02. They are not alternatives to the headline.
- After the answer the concept is treated like any other: the server may target it and
  the agent may explain it. The analysis scores the answer turn only for that reason.
- A concept the turn is directly about is never a candidate, in either arm.
- When the packet was about to teach the picked concept, the taught arm loses that one
  target on that turn (it is taught on a later turn as usual). The held-out arm never
  loses a target.
- A probed taught concept is not offered as a review for 24 hours. A held-out concept
  is never reviewed, so this too touches one arm; it replaces the larger effect of
  reviewing the concept on the very next turn.
- Turn order. The analysis and `probeAnswerEvidenceSql` order a session's turns by
  `created_at`, then `turn_id`. The exposure exclusion (`probeAnswerSql`) and the
  recent-feedback read compare `created_at` alone, so two turns of one session begun at
  the same instant would not be ordered there. Turns of a session begin on separate
  human messages; no such pair is stored (checked on the live table, 2026-11-11).
- `probe_arm` is the picked concept's arm when the turn was decided. Use the stored arm,
  not one recomputed from the concept id, so the analysis survives a change of the
  holdout.
- If the holdout share is changed while probes run, the pick follows it at once (it
  only counts candidates), but concepts that changed arm carry probes from their old
  one. Analyse the periods apart.
- Probes are delivered only through the live turn (`submitLearningTurnFeedback`), not on
  the retrieval-only hook path.

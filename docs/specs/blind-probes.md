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

A turn decided with `blindProbes` on goes through these steps. Steps 1 to 5 look only at
the turn. None of them looks at the arm the coin chose.

1. **Draw.** `draw(turnId) < probeRate`, where `draw` is the first 28 bits of
   `md5("learning-probe:<turnId>")` modulo 100. Otherwise: `not_drawn`.
2. **Task target.** The packet carries at least one of the turn's own concepts as a
   target. Otherwise: `no_target` (a probe never stands alone).
3. **Free slot.** The packet has fewer than five targets. Otherwise: `packet_full`.
4. **Both arms.** Candidates are the catalog concepts within `probeHops` of the turn's
   concepts (`relatedHops`, the spaced-repetition relatedness), except the turn's own
   concepts. Nothing else is excluded. There must be at least one held-out and at least
   one taught candidate. Otherwise: `arm_empty`, and the turn is probed in neither arm.
5. **Size.** The guidance with the longest candidate line of either arm fits the
   4,000-character ceiling. Otherwise: `size`.
6. **Arm.** A fair coin on the turn id (`learning-probe-arm`, draw below 50 is held out).
7. **Pick.** Within the arm every candidate is equally likely (ordered by a hash of turn
   and concept).
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

## What is true about balance, and what is not

True, each with a test (`learning-blind-probes.test.ts`):

- **Same turns.** Whether a turn is probed does not depend on the arm. Held-out and
  taught probes come from one turn population: turns that passed steps 1 to 5 and 8.
- **Fair coin.** On a probed turn the arm is held out with probability one half. So the
  two arms get the same number of probes on average.
- **No taught-only signal in the candidates.** The candidate rule does not use
  suppression (recently taught or demonstrated), the packet's contents or the review
  queue. A recently taught concept is a candidate like any other.
- **Blind line.** The probe line has the same fields and the instruction the same words
  for both arms.
- **The holdout holds.** A held-out concept is never a task anchor, a prerequisite or a
  review, and never in "Teaching targets" or in the guidance's `conceptIds`. The probe
  line is the only place it appears.
- **Off is byte-identical.** With `blindProbes` off the guidance is what it was.
- **Replay-safe.** Draw, arm and pick are pure functions of the lowercased turn id, and
  the decision is stored once with the injection decision.

Not true, and not claimed:

- **Concepts are not probed with equal chance.** The arms get equal numbers of probes,
  but a turn has about four times as many taught candidates as held-out ones, so a
  given held-out concept near the turns is probed about four times as often as a given
  taught one. The held-out arm therefore rests on few concepts: on the real turns of the
  replay below (22 two-arm turns when this was counted), at 2 hops, 29 held-out concepts against 106 taught ones, and three held-out
  concepts carry 41 % of the picks. The headline therefore compares each concept's first
  probe only, every concept counting once; the reading over all probes weights each probe
  by its arm's candidate count and treats a concept's probes as one cluster.
- **"Held out" is not "never taught".** The holdout started on 2026-10-30. Before that
  date 28 of the 140 held-out concepts were reported taught 71 times. A held-out
  concept is one that has not been a teaching target since then.
- **The concepts in the two arms are not alike in what the learner met before.** The
  hash that picks held-out concepts is blind, but with this few concepts chance
  matters: at 2 hops 55 % of held-out picks against 69 % of taught picks fall on a
  concept the learner had met (taught, or matched as more than a mention) before the
  holdout started. The analysis splits on it.
- **Many turns are not probed.** A turn with no held-out concept in range is skipped in
  both arms. See the replay below.
- **The agent can sometimes guess.** See "Limits".

## Balance on the real graph and the real turns

The candidate rule (step 4) replayed on the dev graph (664 catalog concepts, 140 held
out, 2,082 edges in `learning_concept_edges`) and every turn with matches since the
holdout started (2026-10-30T18:05Z to 2026-11-11): 33 turns. Steps 2, 3, 5 and 8 are not
replayed; they do not depend on the arm.

| `probeHops` | Turns with a candidate in both arms | Only taught | Only held out | Mean candidates on those turns (held out / taught) | Old rule: expected held-out share of probes | This rule: the coin on those turns (held out / taught) |
|---|---|---|---|---|---|---|
| 1 | 16 of 33 | 17 | 0 | 1.4 / 4.4 | 33 % | 10 / 6 |
| 2 (default) | 21 of 33 | 12 | 0 | 2.4 / 9.2 | 39 % | 14 / 7 |
| 3 | 21 of 33 | 12 | 0 | 3.3 / 13.2 | 39 % | 14 / 7 |
| 4 | 22 of 33 | 11 | 0 | 4.7 / 17.1 | 40 % | 14 / 8 |
| 5 (all) | 31 of 33 | 2 | 0 | 40.2 / 135.2 | 48 % | 20 / 11 |

- "Old rule" is the first version (the coin first, then a probe if that arm had a
  candidate): held-out probes were the minority and came from fewer turns. Its expected
  share is (turns with a held-out candidate) / (that + turns with a taught candidate).
- Under this rule the expected share is 50 % by construction. The last column is what
  the coin actually gives on these turn ids: 14 of 21 at the default. That is chance on
  a small sample (two-sided binomial p = 0.19). The same coin lands held out on 606 of
  all 1,181 stored turn ids (51.3 %).
- The default is 2 hops: on these turns 3 hops adds no turn and 1 hop loses five. "All"
  probes almost every turn but with concepts from anywhere in the connected graph (40
  held-out candidates per turn), which is no longer "related to the turn".
- Volume is small. At the default rate of 20 %, 5 of the 21 turns draw a probe, and only
  the injected ones deliver it: a few probes per week at this traffic. Raise
  `probeRate` to collect faster.

The same replay runs as a test on a fixed fixture: the shipped catalog with its real
one-in-five holdout, a sparse hash-built graph, 6,000 turns. There the old rule gives
held-out probes about 32 % (1 hop) and 42 % (2 hops) of the time; this rule gives
50 % within 2.5 points, and the turns probed in either arm have the same mean candidate
counts and size within 6 %.

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
| `probe_arm` | the coin, `held_out` or `taught`; set on every drawn turn, delivered or not |
| `probe_held_out_candidates`, `probe_taught_candidates` | candidates in each arm; set on every drawn turn |
| `probe_rate`, `probe_hops` | the settings the decision was made under |
| `probe_concept_id` | the probed concept; set exactly when the outcome is `delivered` |
| `probe_concept_hops` | that concept's own distance from the turn's concepts (the graph is not versioned) |
| `guidance_concept_ids` | the teaching targets the guidance carried on this turn (empty when not injected); stored whether probes are on or off, from migration 0028 |

The table enforces the shape (migrations 0025 and 0030): a concept is stored exactly on
a delivered probe, the concept's distance only on a delivered probe, and a `fail_open`
row carries no arm, no counts and no concept.

When several reasons apply the first in the order of "The rule" is stored. A turn that
never submits feedback stores nothing; that happens before any draw.

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
  it. Size: at most one concept per taught-arm probe, so half the delivered probes, and
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
a prerequisite before its second, and a held-out concept has simply been asked before
(held-out concepts are repeated about four times as often). So only a concept's first
probe is free of both, and the headline difference is the first-probe one for that
reason ("The headline difference").

## Analysis

Everything here is in `learning-blind-probes.ts` and tested in
`learning-blind-probes.test.ts` (the arithmetic, against hand-computed figures, and the
interval's coverage on a simulated learner) and
`learning-spaced-repetition-db.test.ts` (the SQL). Parameters of every query: the user
id and the start of the holdout (`HOLDOUT_STARTED_AT`). Probes delivered before that
date are left out and do not count towards a concept's probe index.

`bun --env-file=/etc/learner/db.env scripts/measurement-report.ts` prints all of it,
read-only. Nothing in the app shows it yet.

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
| `all` | every scored probe, weighted by its arm's candidate count, a concept's probes as one cluster | sensitivity |
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
| `daysGap` | mean days since the holdout began, taught minus held-out, with the same weights, over scored probes |
| `priorProbesGap` | mean number of earlier probes of the same concept behind a scored probe, taught minus held-out, with the same weights. 0 for `first` |

Why the first probe is the headline:

- **Being asked is itself a treatment, and the arms get unequal doses of it.** A probe
  is retrieval practice, and its answer is graded and steers later teaching (see "What
  a probe changes later"). A held-out concept is probed about four times as often as a
  taught one, so a reading that pools repeat probes credits the held-out arm with
  practice the taught arm did not get. The first probe is the only one with no earlier
  probe behind it. `priorProbesGap` on the two sensitivity readings shows how unequal
  the exposure was.
- **Probe and concept coincide.** One probe per concept, so there is no choice of unit,
  no weight and no within-concept correlation: the comparison is a two-sample one over
  concepts.
- **What it costs.** A concept whose first probe was not scored (no answer, or
  explained) is not in the headline even if a later probe was scored; `unscored` counts
  them and `ifExplained` bounds the explained ones. Repeat probes add nothing, so the
  headline stops improving once most concepts near the conversation have been probed
  once: its precision is set by the number of held-out concepts, not of probes.
- **What it does not remove: centrality.** Within an arm a concept that is related to
  more turns is probed sooner and is more likely to have a first probe at all, and the
  taught arm has many more concepts to draw from, so its probed concepts are the more
  central ones. If central concepts are also the better known ones, the headline leans
  towards the taught arm with no teaching effect at all. Weighting by the candidate
  count does not undo this (simulated, below), so the headline is not weighted. The
  stratum `met_before` removes the part of it that is prior exposure.
- **Timing.** Held-out concepts reach their first probe sooner after the holdout
  started. Nothing adjusts for that; `daysGap` reports it, and a difference with a
  large `daysGap` should be read as confounded with time.

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

The two sensitivity readings and their known bias:

- `all` weights a probe by the number of candidates its arm picked from
  (`probe_held_out_candidates` / `probe_taught_candidates`), which undoes the uniform
  pick, so both arms estimate "the demonstrated rate of a candidate concept on a probed
  turn". It uses every scored probe and is the most precise reading.
- `concept` answers "for an average probed concept, over all its probes".
- **Both are biased towards zero, or below it, by any effect of being asked**, because
  the held-out arm's probes have more earlier probes behind them. They are reported to
  show how much the headline depends on leaving repeat probes out, not as alternatives
  to it. If they sit well below the headline with a clearly negative `priorProbesGap`,
  that is the testing effect, not evidence against teaching.

Report the headline with its `interval`, both concept counts, the unscored counts,
`ifExplained`, `daysGap`, and the two sensitivity readings with their `priorProbesGap`
beside it. `scripts/measurement-report.ts` prints exactly that.

### How the analysis was checked

`learning-blind-probes.simulation.ts` simulates a learner under the production rule
(120 concepts with log-normal centrality, one in five held out, half met before; a turn
relates about eleven concepts in proportion to centrality, is probed only with a
candidate in both arms, fair coin, uniform pick). `probeCoverage` runs `probeDifference`
on it many times. `bun scripts/probe-simulation.ts` prints the table below (2,000
replications per row, seed 20261111); the fixed-seed tests in
`learning-blind-probes.test.ts` hold the first and third blocks in place.

"Bias" is the mean difference minus the true effect; "coverage" the share of 95 %
intervals that hold the true effect; "excludes 0" the share of intervals that exclude
zero, which is the false-positive rate when the true effect is 0.

| World | Probes | `first`: bias | spread / mean se | coverage | excludes 0 | `all`: bias | spread / mean se | coverage | excludes 0 | `concept`: bias | coverage | excludes 0 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| no effect | 30 | 0.000 | 0.240 / 0.235 | 95.5 % | 4.5 % | -0.002 | 0.224 / 0.216 | 95.5 % | 4.5 % | -0.003 | 95.1 % | 4.9 % |
| no effect | 60 | -0.001 | 0.182 / 0.181 | 95.6 % | 4.4 % | -0.004 | 0.159 / 0.156 | 95.5 % | 4.5 % | -0.003 | 95.0 % | 5.0 % |
| no effect | 120 | -0.000 | 0.153 / 0.149 | 95.0 % | 5.0 % | +0.002 | 0.116 / 0.116 | 96.3 % | 3.8 % | +0.001 | 95.3 % | 4.7 % |
| no effect | 300 | -0.003 | 0.128 / 0.128 | 95.5 % | 4.5 % | -0.002 | 0.087 / 0.084 | 95.0 % | 5.0 % | -0.002 | 94.5 % | 5.5 % |
| no effect, ability rises with centrality | 30 | +0.027 | 0.242 / 0.236 | 95.1 % | 4.9 % | +0.011 | 0.229 / 0.219 | 96.1 % | 3.9 % | +0.024 | 95.9 % | 4.1 % |
| no effect, ability rises with centrality | 60 | +0.027 | 0.187 / 0.182 | 94.6 % | 5.4 % | +0.008 | 0.164 / 0.160 | 94.8 % | 5.2 % | +0.025 | 94.5 % | 5.5 % |
| no effect, ability rises with centrality | 120 | +0.033 | 0.156 / 0.150 | 94.0 % | 6.0 % | +0.011 | 0.122 / 0.120 | 94.7 % | 5.3 % | +0.033 | 93.5 % | 6.5 % |
| no effect, ability rises with centrality | 300 | +0.023 | 0.130 / 0.129 | 94.2 % | 5.8 % | +0.006 | 0.094 / 0.090 | 93.7 % | 6.3 % | +0.026 | 93.8 % | 6.2 % |
| no effect, testing effect 0.3 per probe | 30 | 0.000 | 0.240 / 0.235 | 95.5 % | 4.5 % | -0.030 | 0.225 / 0.217 | 95.2 % | 4.8 % | -0.019 | 95.3 % | 4.7 % |
| no effect, testing effect 0.3 per probe | 60 | -0.001 | 0.182 / 0.181 | 95.6 % | 4.4 % | -0.053 | 0.158 / 0.158 | 95.0 % | 5.1 % | -0.032 | 94.8 % | 5.3 % |
| no effect, testing effect 0.3 per probe | 120 | -0.000 | 0.153 / 0.149 | 95.0 % | 5.0 % | -0.079 | 0.116 / 0.119 | 91.5 % | 8.5 % | -0.047 | 93.5 % | 6.5 % |
| no effect, testing effect 0.3 per probe | 300 | -0.003 | 0.128 / 0.128 | 95.5 % | 4.5 % | -0.102 | 0.084 / 0.084 | 79.7 % | 20.3 % | -0.079 | 85.5 % | 14.4 % |
| no effect, testing 0.3 and centrality | 30 | +0.027 | 0.242 / 0.236 | 95.1 % | 4.9 % | -0.014 | 0.229 / 0.219 | 95.6 % | 4.4 % | +0.008 | 96.0 % | 4.0 % |
| no effect, testing 0.3 and centrality | 60 | +0.027 | 0.187 / 0.182 | 94.6 % | 5.4 % | -0.035 | 0.162 / 0.161 | 94.5 % | 5.5 % | -0.000 | 94.3 % | 5.7 % |
| no effect, testing 0.3 and centrality | 120 | +0.033 | 0.156 / 0.150 | 94.0 % | 6.0 % | -0.056 | 0.118 / 0.122 | 93.6 % | 6.4 % | -0.010 | 94.9 % | 5.1 % |
| no effect, testing 0.3 and centrality | 300 | +0.023 | 0.130 / 0.129 | 94.2 % | 5.8 % | -0.081 | 0.083 / 0.088 | 87.4 % | 12.6 % | -0.044 | 92.9 % | 7.1 % |
| true effect 0.15 | 30 | -0.001 | 0.242 / 0.234 | 95.4 % | 9.4 % | -0.003 | 0.223 / 0.215 | 95.4 % | 8.5 % | -0.004 | 95.2 % | 9.7 % |
| true effect 0.15 | 60 | +0.003 | 0.178 / 0.180 | 95.6 % | 11.7 % | -0.002 | 0.155 / 0.156 | 95.8 % | 13.8 % | -0.001 | 95.5 % | 13.9 % |
| true effect 0.15 | 120 | +0.001 | 0.154 / 0.149 | 94.5 % | 17.3 % | +0.003 | 0.117 / 0.116 | 95.1 % | 23.2 % | +0.001 | 95.2 % | 24.1 % |
| true effect 0.15 | 300 | -0.004 | 0.128 / 0.128 | 95.0 % | 20.2 % | -0.003 | 0.087 / 0.084 | 94.5 % | 37.9 % | -0.002 | 95.2 % | 35.9 % |
| true effect 0.15, testing 0.3 per probe | 30 | -0.001 | 0.242 / 0.234 | 95.4 % | 9.4 % | -0.029 | 0.225 / 0.216 | 95.0 % | 7.3 % | -0.020 | 94.8 % | 8.4 % |
| true effect 0.15, testing 0.3 per probe | 60 | +0.003 | 0.178 / 0.180 | 95.6 % | 11.7 % | -0.051 | 0.154 / 0.157 | 95.5 % | 8.5 % | -0.029 | 95.1 % | 9.7 % |
| true effect 0.15, testing 0.3 per probe | 120 | +0.001 | 0.154 / 0.149 | 94.5 % | 17.3 % | -0.078 | 0.117 / 0.117 | 90.8 % | 8.2 % | -0.047 | 93.0 % | 13.5 % |
| true effect 0.15, testing 0.3 per probe | 300 | -0.004 | 0.128 / 0.128 | 95.0 % | 20.2 % | -0.105 | 0.081 / 0.082 | 78.3 % | 7.1 % | -0.081 | 85.4 % | 11.9 % |

What the table says:

- With no effect of any kind, all three readings are unbiased and their intervals hold
  zero about 95 % of the time at every size, and no replication has a zero error.
- With a testing effect (each earlier probe of a concept adds 0.3 to its log-odds) and
  no teaching effect, the headline is untouched. The `all` reading drifts below zero as
  probes accumulate and its false-positive rate climbs with it; `concept` follows more
  slowly.
- When ability rises with centrality (0.5 per log unit) and nothing is taught, the
  headline leans towards the taught arm by about +0.02 to +0.03, small against its
  standard error at these sizes (the false-positive rate stays near 5 to 6 %), but it
  does not shrink with more probes. It is the reason to read a small positive headline
  with caution, and it is listed under "Limits".
- The headline's standard error stops falling as probes are added (0.18 at 60 probes,
  0.13 at 300): it is bounded by the number of held-out concepts. Its power is low for
  that reason: a true effect of 0.15 is detected in about one run in five at 300
  probes, against about two in five for the `all` reading when there is no testing
  effect. That precision is what the headline gives up to stay unbiased.
- At 30 probes one replication in 2,000 had fewer than two concepts in an arm and gave
  no result; the rates there are over the other 1,999.

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
  changing it changes the candidate pools and how often each concept is probed. Keep
  it fixed for a run; if it was changed, analyse each value of the stored `probe_hops`
  separately.
- **With randomized injection on** nothing changes here. A probe needs an injected
  turn, and the injection coin does not know the arm. See
  [randomized-injection.md](randomized-injection.md) for what changes there.

Reading it:

- `answered` should be about equal across arms. If it is not, the probe is not blind
  in practice and `demonstrated` is not a fair comparison.
- Check the coin on the stored draws:
  `SELECT probe_arm, count(*) FROM learning_live_feedback_turns WHERE probe_held_out_candidates > 0 AND probe_taught_candidates > 0 GROUP BY 1`.
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

## Limits and what is left

- The server controls the instruction, not the agent's behaviour. Whether the agent asks
  exactly one question and does not teach is not verified live. No live turn has been
  probed yet: the switch is off.
- The arm can sometimes be guessed from the session. A taught concept may have been a
  "Teaching targets" entry earlier in the same session; a held-out concept never was.
  The agent is not told about arms, and the question is a fixed template, but the agent
  also tags the answer, and it remembers what it explained. Measured on the replay's 22
  two-arm turns: 9 % of the taught arm's pick weight falls on a concept the session
  had already reported taught or reviewed, against 5 % for the held-out arm. The taught
  figure is a lower bound, because teaching targets were not stored then; they are now
  (`guidance_concept_ids`), and `PROBE_LEAK_SQL` reports the split. Such concepts are
  not excluded: that would again be a rule only taught concepts can trigger.
- The picked concept is one the packet was about to teach on 2 of those 22 turns (9 %).
  It is then probed instead of taught on that turn.
- A probe is itself an exposure, and answering it can teach. Held-out concepts are
  probed more often per concept (see above), so a high `probeRate` erodes the holdout's
  contrast faster than it adds taught-arm practice.
- With about 29 held-out concepts in play, the comparison has few units. Expect wide
  intervals until many more concepts have been probed; more probes of the same concepts
  do not narrow the headline.
- The headline (first probes) leans towards the taught arm when central concepts are the
  better known ones: about +0.03 in the simulation under "How the analysis was checked",
  with no teaching effect. Nothing in the analysis removes it.
- The two sensitivity readings pool repeat probes and are biased towards zero by any
  effect of being asked. They are not alternatives to the headline.
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
- `probe_arm` is the arm when the turn was decided. Use the stored arm, not one
  recomputed from the concept id, so the analysis survives a change of the holdout.
- Probes are delivered only through the live turn (`submitLearningTurnFeedback`), not on
  the retrieval-only hook path.

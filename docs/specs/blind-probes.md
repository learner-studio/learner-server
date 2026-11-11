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
  concepts carry 41 % of the picks. The analysis treats the concept as the unit for
  that reason.
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

When several reasons apply the first in the order of "The rule" is stored. A turn that
never submits feedback stores nothing; that happens before any draw.

## What a probe changes later, and what it does not

An answered probe shows up in a later turn's matches. Teaching and review exist for
taught concepts only, so anything a probe answer changes there changes one arm.

Closed, each with a test that fails when the exclusion is removed. A "probe answer" is a
match for a concept that the same session probed in the 24 hours before that turn.

- **Suppression and gaps.** The live policy does not see probe answers
  (`readRecentLiveFeedback`), so an answer neither pauses teaching of the concept nor
  opens a gap.
- **The agent's recent feedback.** The begin packet is built from the same filtered
  view, so the agent is not told about the answer on later turns.
- **Review schedule.** `readReviewHistory` does not count a probe answer as an exposure,
  nor a message cited by the published assessment that was said in the 24 hours after a
  probe of that concept.

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
- **Hidden evidence.** For 24 hours after a probe, in that session, a real
  misconception or gap on the probed concept is hidden from the live policy together
  with the answer, so the remedial teaching it would have triggered does not happen.
  Size: the same concept and window as above.
- **Teaching reported by the agent.** If the agent lists the probed concept in
  `taughtConceptIds`, that is teaching and is treated as teaching.

The analysis below is built so that neither open path can reach the outcome: it scores
the answer turn only, which comes before any later treatment.

## Analysis

`PROBE_ANALYSIS_SQL` in `learning-blind-probes.ts` (tested in
`learning-spaced-repetition-db.test.ts`). Parameters: the user id and the start of the
holdout (`HOLDOUT_STARTED_AT`, or the current phase's `started_at` in
`learning_holdout_phases`). One row per arm and stratum:

| Column | Meaning |
|---|---|
| `arm` | `held_out` or `taught` (the stored `probe_arm`) |
| `met_before` | the concept was taught or matched (not a bare mention) before the holdout started |
| `concepts` | concepts with at least one scored probe: the unit |
| `probes`, `unscored_probes` | scored probes; probes with no answer turn or taught instead of asked |
| `answered`, `demonstrated` | mean over concepts of each concept's rate over its scored probes |
| `sd_demonstrated` | standard deviation of that rate across concepts |

How it is built, and why:

- **The answer turn only.** A probe is scored on the session's next turn and nowhere
  else. From the turn after that the server may teach the probed concept (it stays
  teachable on purpose), and only a taught concept can be taught, so a longer window
  would credit the taught arm with teaching that followed the question.
- **Unscored probes.** A probe with no next turn has no answer. A probe whose answer
  turn lists the concept in `taughtConceptIds` was explained instead of asked. Neither
  is scored; a large or unequal `unscored_probes` is itself a finding.
- **Concepts, not probes, are the unit.** Each concept counts once, with its own rate.
  The standard error of an arm's `demonstrated` is `sd_demonstrated / sqrt(concepts)`.
  Probes of one concept are not independent, and the held-out arm repeats concepts far
  more than the taught arm.
- **Split by `met_before`.** Compare the arms within each stratum, then combine the two
  differences weighted by the number of concepts. A pooled comparison would mix the
  arms' different shares of concepts the learner had met before the holdout.

Reading it:

- `answered` should be about equal across arms within a stratum. If it is not, the
  probe is not blind in practice and `demonstrated` is not a fair comparison.
- `demonstrated` by arm is the holdout comparison on an equal footing: of the concepts
  we asked about, how often the learner could answer, for concepts taught since
  2026-10-30 against concepts not taught since then.
- Check the coin on the stored draws:
  `SELECT probe_arm, count(*) FROM learning_live_feedback_turns WHERE probe_held_out_candidates > 0 AND probe_taught_candidates > 0 GROUP BY 1`.
- The outcome is tagged by the coding agent that asked the question. It does not know
  the arm, but see "Limits" on guessing.
- For the mastery view, restrict the holdout comparison to readings whose evidence is a
  probe answer: `learning_mastery_readings.evidence_at` within a day after a probe of
  that concept.

## Limits and what is left

- The server controls the instruction, not the agent's behaviour. Whether the agent asks
  exactly one question and does not teach is not verified live. No live turn has been
  probed yet: the switch is off.
- The arm can sometimes be guessed from the session. A taught concept may have been a
  "Teaching targets" entry earlier in the same session; a held-out concept never was.
  The agent is not told about arms, but it may word the question differently for
  something it has already explained. Such concepts are not excluded: that would again
  be a rule only taught concepts can trigger. Read a sample of probed turns before
  trusting the numbers.
- A probe is itself an exposure, and answering it can teach. Held-out concepts are
  probed more often per concept (see above), so a high `probeRate` erodes the holdout's
  contrast faster than it adds taught-arm practice.
- With about 29 held-out concepts in play, the comparison has few units. Expect wide
  intervals until many more concepts have been probed.
- After the answer the concept is treated like any other: the server may target it and
  the agent may explain it. The analysis scores the answer turn only for that reason.
- A concept the turn is directly about is never a candidate, in either arm.
- When the packet was about to teach the picked concept, the taught arm loses that one
  target on that turn (it is taught on a later turn as usual). The held-out arm never
  loses a target.
- `probe_arm` is the arm at the holdout share in force when the turn was decided
  (`holdoutBuckets`); after a change of share use the stored arm, not a recomputed one.
- Probes are delivered only through the live turn (`submitLearningTurnFeedback`), not on
  the retrieval-only hook path.

# Randomized injection in the live intervention policy

Status: implemented, off by default. Setting `randomizedInjection` in
`LearningPolicySettings` (`packages/contract/src/learning/learning-policy.ts`); the
decision is `decideTurnInjection` in
`packages/core/src/lib/learning/learning-intervention-policy.ts`; columns from
migration 0019.

## Why

The default injection rule is a quota: a turn with something worth teaching is
injected unless the session already used its allowance (at most `injectionRate`/20
injections in any 5 consecutive turns). Two things made its effect unmeasurable:

- `injected = false` meant both "nothing worth teaching" and "worth teaching, over
  quota", so the not-injected group was mostly turns that were never candidates.
- Which eligible turns get injected depends on their position in the session (the
  first ones always do), so injected and skipped turns differ in more than the
  injection.

## Behaviour

| `randomizedInjection` | A turn worth teaching is injected when |
|---|---|
| `false` (default) | the quota allows it. Decisions are exactly what they were before this feature. |
| `true` | its coin is heads: `draw(turnId) < injectionRate`, where `draw` is the first 28 bits of `md5("learning-injection:<turnId>")` modulo 100. |

- The coin is a pure function of the turn id: a replayed submission gets the same
  answer (it is also stored), and anyone can recompute it (SQL twin `turnDrawSql`;
  an integration test checks every stored assignment against it).
- The quota is not applied in randomized mode. The rate holds on average, not in
  every five turns: at 40 % three injected turns in a row will happen.
- Raising the rate only adds turns: a turn injected at 40 % is injected at 60 %.
- A turn with nothing worth teaching is never injected in either mode.

## What is stored

On `learning_live_feedback_turns`, written once with the decision, in both modes
(null on turns decided before migration 0019):

| Column | Meaning |
|---|---|
| `injected` | the guidance carried the teaching intervention (unchanged) |
| `injection_eligible` | there was something worth teaching: the turn was a candidate |
| `injection_mode` | `quota` or `randomized`: how the candidate was decided |
| `injection_rate` | the slider at the time (the coin's probability, in percent) |

## Analysis

Compare eligible turns only, randomized mode only, injected against not injected.
Outcome here: learner evidence (a `learner_evidence` match with outcome
`demonstrated` or `partial`) in the next N turns of the same session.

The query is `injectionAnalysisSql('turn')` in `learning-intervention-policy.ts`,
tested in `learning-spaced-repetition-db.test.ts`. Parameters: the user id and N. One
row per `injection_rate` and arm: `units` (turns), `evidence_per_unit`, `sd`,
`share_with_evidence`, `turns_after`.

### Blind probes are kept out of it

[Blind probes](blind-probes.md) can be on at the same time. A probe is delivered only
on an injected turn, and it asks the learner a question, so it produces exactly the
evidence this analysis counts, in the injected arm only. Left in, the probe's effect
would be read as the injection's. The query removes it in two steps:

- **Turns that would deliver a probe are not compared, in either arm.** Those are the
  turns with `probe_outcome` `delivered` (injected) or `not_injected` (the same turn,
  had the coin gone the other way). Every probe gate runs before the injection coin
  and does not depend on it, so this set is the same whichever way the coin falls and
  dropping it keeps the arms comparable. Dropping `delivered` alone would not: it
  would remove turns from the injected arm only.
- **A probe answer is not counted as evidence.** A compared turn can be followed, inside
  its N turns, by a probed turn. The match for the probed concept on the turn right
  after that probe is left out of the count (the same definition of a probe answer as
  everywhere else).

What is left to the probes: a later probed turn still carries its one-line question, and
the learner may say more than the answer. That is not removed. Injected turns are
followed by slightly more probes only if injecting changes how long the session goes on;
check `turns_after`.

The cost: at probe rate p, about p times the share of turns with candidates in both
arms is dropped from this analysis (on the blind-probe replay, 22 of 33 turns had both
at 2 hops, so about 13 % of eligible turns at the default 20 %). The policy screen
warns when both switches are on.

Reading it:

- Group by `injection_rate`: turns decided at different rates have different
  probabilities of injection, so pool them only with weights.
- `turns_after` should be about equal across arms; if injected turns are followed
  by fewer turns, sessions end sooner after an injection, and that is a result too.
- Audit the assignment: `injected` must equal
  `(('x' || substr(md5('learning-injection:' || lower(turn_id::text)), 1, 7))::bit(28)::int % 100) < injection_rate`
  on every eligible randomized row. The TypeScript draw lowercases the id, as
  Postgres does when it prints a uuid.

### What the coin does and does not randomize

Within one turn the coin is sound: given that the turn is eligible, heads or tails
depends on nothing but the turn id. So injected and not-injected eligible turns are
comparable, turn by turn. Three things still shape what the comparison means and
how sure it is.

1. **Which turns are eligible depends on earlier coins.** What the agent taught
   goes into the session's suppression for 24 hours, and what it taught depends on
   whether earlier turns were injected. Measured on dev since 2026-10-01:
   taught-suppression changes the eligibility of 8 of 193 turns with a teachable
   match (4 %): 1 of 46 after an injected turn, 7 of 147 after a not-injected one.
   Earlier coins also act through what the learner and the agent do next, in this
   session and in later ones, and through delivered reviews when spaced repetition
   is on. This does not bias the comparison of a turn's own two arms: its coin is
   independent of how it became eligible. It changes WHICH turns are compared: the
   eligible turns are the ones this policy, with its own history of coins, produces.
2. **Outcome windows overlap.** A turn's next N turns contain later eligible turns
   with their own coins. Those coins are independent of this turn's coin, so they
   add noise, not bias. They also make turns of one session dependent on each
   other, so turns are not independent observations.
3. **The outcome is not blind.** The `learner_evidence` matches are tagged by the
   coding agent that received (or did not receive) the injection. An agent primed
   on a concept may tag later messages as evidence for it more readily. Both
   analyses below measure the effect on *tagged* evidence.

### Two analyses, two questions

Both are unbiased for their own question. They answer different questions, so a
difference between them is not a contradiction.

**A. All eligible turns** (`injectionAnalysisSql('turn')`). Estimand: the average effect of
injecting an eligible turn, over the eligible turns this policy produces, each turn
weighted equally. Sessions with many eligible turns count more. Its errors must be
clustered by session (or use a permutation of the coin within sessions); treating
turns as independent overstates the certainty because of point 2.

**B. The first eligible turn of each session** (below). Estimand: the total effect
of injecting a session's first eligible turn, including everything that changes
later in the session, each session weighted equally. No coin was flipped earlier in
that session, so sessions are independent units as far as this session's coins go;
earlier sessions' coins can still have shaped the learner. It uses one turn per
session, so it needs many sessions.

`injectionAnalysisSql('session')`: the same query over each session's first eligible
turn, if it was decided in randomized mode. The probe exclusions are the same, so a
session whose first eligible turn would deliver a probe is not compared.

Compare the arms with a two-sample test on sessions (`evidence_per_unit`, `sd`,
`units`).

Report both, each with its estimand. A is the answer to "what does an injection do
on a typical eligible turn"; B to "what does starting a session with an injection
do to the session". If they differ, the effect differs between first and later
turns, or between long and short sessions; neither is the wrong one.

For both, point 3 stands. A less exposed outcome is the published mastery reading
(`learning_mastery_readings`, by `evidence_at` inside the window): the grader is a
separate call that is not handed the guidance. It still reads the agent's replies,
which differ between the arms.

## Not in scope

- Concept-level outcomes (did mastery of the injected concept move): that is the
  concept holdout's question, measured on `learning_mastery_readings.evidence_at`.
- A minimum gap between injections in randomized mode.

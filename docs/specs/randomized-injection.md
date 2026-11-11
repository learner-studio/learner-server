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

```sql
-- $1 = user id, $2 = N (turns to look ahead)
WITH turns AS (
  SELECT t.*, row_number() OVER (PARTITION BY session_id ORDER BY created_at) AS n
  FROM learning_live_feedback_turns t WHERE user_id = $1
), eligible AS (
  SELECT * FROM turns WHERE injection_mode = 'randomized' AND injection_eligible
), yield AS (
  SELECT e.session_id, e.turn_id, e.injected, e.injection_rate,
    count(m) FILTER (WHERE m->>'relationship' = 'learner_evidence' AND m->>'outcome' IN ('demonstrated', 'partial')) AS evidence,
    count(DISTINCT f.turn_id) AS turns_after
  FROM eligible e
  LEFT JOIN turns f ON f.session_id = e.session_id AND f.n > e.n AND f.n <= e.n + $2
  LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(f.feedback->'matches') = 'array' THEN f.feedback->'matches' ELSE '[]' END) m ON true
  GROUP BY 1, 2, 3, 4
)
SELECT injection_rate, injected AS arm, count(*) AS turns,
  avg(evidence) AS evidence_per_turn, avg((evidence > 0)::int) AS share_with_evidence, avg(turns_after) AS turns_after
FROM yield GROUP BY 1, 2 ORDER BY 1, 2;
```

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

**A. All eligible turns** (the first query). Estimand: the average effect of
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

```sql
-- $1 = user id, $2 = N. One row per session: its first eligible turn, if decided in randomized mode.
WITH turns AS (
  SELECT t.*, row_number() OVER (PARTITION BY session_id ORDER BY created_at) AS n
  FROM learning_live_feedback_turns t WHERE user_id = $1
), firsts AS (
  SELECT DISTINCT ON (session_id) * FROM turns WHERE injection_eligible ORDER BY session_id, n
), yield AS (
  SELECT e.session_id, e.injected, e.injection_rate,
    count(m) FILTER (WHERE m->>'relationship' = 'learner_evidence' AND m->>'outcome' IN ('demonstrated', 'partial')) AS evidence,
    count(DISTINCT f.turn_id) AS turns_after
  FROM firsts e
  LEFT JOIN turns f ON f.session_id = e.session_id AND f.n > e.n AND f.n <= e.n + $2
  LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(f.feedback->'matches') = 'array' THEN f.feedback->'matches' ELSE '[]' END) m ON true
  WHERE e.injection_mode = 'randomized'
  GROUP BY 1, 2, 3
)
SELECT injection_rate, injected AS arm, count(*) AS sessions,
  avg(evidence) AS evidence_per_session, stddev_samp(evidence) AS sd, avg((evidence > 0)::int) AS share_with_evidence, avg(turns_after) AS turns_after
FROM yield GROUP BY 1, 2 ORDER BY 1, 2;
```

Compare the arms with a two-sample test on sessions (`evidence_per_session`, `sd`,
`sessions`).

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

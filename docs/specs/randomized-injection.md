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
  `(('x' || substr(md5('learning-injection:' || turn_id::text), 1, 7))::bit(28)::int % 100) < injection_rate`
  on every eligible randomized row.
- One learner, turns clustered in sessions: treat sessions, not turns, as the
  unit when judging whether a difference is noise.
- The window overlaps the next eligible turn's own injection. With a fair coin
  that adds noise equally to both arms; it does not bias the comparison.

## Not in scope

- Concept-level outcomes (did mastery of the injected concept move): that is the
  concept holdout's question, measured on `learning_mastery_readings.evidence_at`.
- A minimum gap between injections in randomized mode.

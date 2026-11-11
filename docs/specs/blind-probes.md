# Blind probes in the live intervention policy

Status: implemented, off by default. Settings `blindProbes` and `probeRate` in
`LearningPolicySettings`; selection in
`packages/core/src/lib/learning/learning-blind-probes.ts`; delivered through
`taskTeachingContext`; column `probe_concept_id` from migration 0021.

## What it is for

The concept holdout (`osmosis-concept-holdout`) never teaches one concept in five and
compares how held-out and taught concepts move. But teaching a concept also makes the
agent ask about it, so taught concepts get more chances to show evidence: part of any
difference between the arms is how often we looked, not what the learner knows.

A blind probe gives both arms the same look: one short check question about a concept
related to the turn, drawn with equal probability from the held-out and the taught arm,
worded identically for both. It is a question, never a lesson.

## Behaviour

When `blindProbes` is on, a turn that is injected and whose draw is below `probeRate`
(`draw(turnId)`, the first 28 bits of `md5("learning-probe:<turnId>")` modulo 100) gets
at most one probe:

1. **Arm first.** A fair coin on the turn id (`learning-probe-arm`) picks held-out or
   taught before anything else is looked at.
2. **Candidates.** Catalog concepts within `reviewHops` of the turn's concepts (the
   spaced-repetition relatedness, `relatedHops`), in the chosen arm, excluding the
   turn's own concepts, anything the guidance already carries and recently
   demonstrated (suppressed) concepts.
3. **Pick.** Every candidate is equally likely (ordered by a hash of turn and concept).
   If the chosen arm has no candidate there is no probe: falling back to the other arm
   would probe taught concepts more often.

The guidance then ends with one extra line and one fixed instruction:

```
Blind probe: {"conceptId":"…","title":"…","role":"probe","hops":1,"relatedTo":"…"}
role "probe": a check, not a teaching target. End your reply with exactly ONE question in this form: "Quick check: in one sentence, what is <title>, and where would it matter in what we are doing?" Do not explain, define, hint at or teach that concept …
```

Guarantees, each with a test (`learning-blind-probes.test.ts`):

- **Blind.** The line has the same fields and the instruction the same words for both
  arms; nothing says which arm the concept is in.
- **The holdout holds.** A held-out concept is still never a task anchor, a
  prerequisite or a review, and never in the "Teaching targets" list or in the
  guidance's `conceptIds`. The probe line is the only place it can appear.
- **Lowest priority.** A probe takes a concept slot only when prerequisites, the anchor,
  the review and the other task concepts leave one of the five; it is the first thing
  dropped under the 4,000-character ceiling; and a turn with nothing to teach gets no
  probe (a probe never makes a turn injectable).
- **Off is byte-identical.** With `blindProbes` off the guidance is exactly what it was.
- **Replay-safe.** Draw, arm and pick are pure functions of the turn id; the delivered
  probe is stored on the turn with the injection decision.

## Settings

| Key | Type | Default | Meaning |
|---|---|---|---|
| `blindProbes` | boolean | `false` | Master switch. |
| `probeRate` | 0–100 in steps of 20 | `20` | Percent of injected turns that draw a probe. The delivered share is lower: an empty arm or a full packet delivers none. |

Relatedness uses `reviewHops`, also when spaced repetition is off. Both settings live in
the single `learning_policy_settings` row and are edited in the web policy panel.

## What is stored

`learning_live_feedback_turns.probe_concept_id`: the probe the turn's guidance delivered
(null when none, and on not-injected turns). The arm is a function of the concept id
(`holdoutBucketSql(probe_concept_id) = 0` is held out), so it is not stored. A draw that
delivered nothing is not stored; it can be recomputed from the turn id.

## Analysis

Did the learner show evidence for the probed concept in the next N turns, by arm:

```sql
-- $1 = user id, $2 = N
WITH turns AS (
  SELECT t.*, row_number() OVER (PARTITION BY session_id ORDER BY created_at) AS n
  FROM learning_live_feedback_turns t WHERE user_id = $1
), probed AS (
  SELECT *, (('x' || substr(md5('osmosis-concept-holdout:' || probe_concept_id), 1, 7))::bit(28)::int % 5) = 0 AS held_out
  FROM turns WHERE probe_concept_id IS NOT NULL
)
SELECT p.held_out, count(*) AS probes,
  avg((EXISTS (
    SELECT 1 FROM turns f, jsonb_array_elements(CASE WHEN jsonb_typeof(f.feedback->'matches') = 'array' THEN f.feedback->'matches' ELSE '[]' END) m
    WHERE f.session_id = p.session_id AND f.n > p.n AND f.n <= p.n + $2
      AND m->>'conceptId' = p.probe_concept_id AND m->>'relationship' = 'learner_evidence'))::int) AS answered,
  avg((EXISTS (
    SELECT 1 FROM turns f, jsonb_array_elements(CASE WHEN jsonb_typeof(f.feedback->'matches') = 'array' THEN f.feedback->'matches' ELSE '[]' END) m
    WHERE f.session_id = p.session_id AND f.n > p.n AND f.n <= p.n + $2
      AND m->>'conceptId' = p.probe_concept_id AND m->>'outcome' = 'demonstrated'))::int) AS demonstrated
FROM probed p GROUP BY 1;
```

- `answered` should be about equal across arms: that is the point of the probe. If it
  is not, the probe is not blind in practice (for example the agent words it
  differently) and the comparison below is not fair.
- `demonstrated` by arm is the holdout comparison on an equal footing: of the concepts
  we asked about, how many the learner could explain, taught versus never taught.
- For the mastery view, restrict the holdout comparison to readings whose evidence is a
  probe answer: `learning_mastery_readings.evidence_at` within a day after a probe of
  that concept.
- Check the agent kept the rule: a probed concept in the same turn's
  `feedback->'taughtConceptIds'` means it was taught, not probed.

## Limits and what is left

- The server controls the instruction, not the agent's behaviour. Whether the agent asks
  exactly one question and does not teach is not verified live; the check above
  (`taughtConceptIds`) and a read of a few probed turns should come before trusting the
  numbers. No live turn has been probed yet: the switch is off.
- A probe is itself an exposure for a held-out concept, and answering it can teach.
  Both arms get the same probes, so the comparison stays fair, but a high `probeRate`
  erodes the holdout's "never exposed" contrast. Start at 20 %.
- If the learner answers and the agent then explains the concept on a later turn, that
  turn's guidance does not repeat the "do not teach" instruction. Not handled.
- The probe is only drawn from related concepts (within `reviewHops`), not from the
  turn's own concepts. A held-out concept the turn is directly about is neither taught
  nor probed.
- Probes are delivered only through the live turn (`submitLearningTurnFeedback`), not on
  the retrieval-only hook path.

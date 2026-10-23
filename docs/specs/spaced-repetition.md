# Spaced repetition in the live intervention policy

Status: implemented. Settings live in `LearningPolicySettings`
(`packages/contract/src/learning/learning-policy.ts`); the schedule and queue are
`packages/core/src/lib/learning/learning-spaced-repetition.ts`.

## Behaviour

When the operator turns spaced repetition ON, every live hook turn (the
`submitLearningTurnFeedback` RPC) looks at the concepts the learner has met
before, works out which of them are **due** for review from the last time they
were exposed and the learner's published mastery, and, if the most urgent due
concept is **related** to the turn, adds it to the agent's guidance as one
teaching target with `role: "review"`. The agent is told to re-expose it in a
sentence or two where it connects to the task, never as a detour.

When the setting is OFF nothing changes: no extra query runs and the guidance is
byte-for-byte what it was before this feature.

## Settings (one schema, one stored row)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `spacedRepetition` | boolean | `false` | Master switch. Off by default so deploying the code does not change what the hook injects; the operator turns it on in the policy panel. |
| `reviewHops` | integer 1-5 | `1` | "Hop distance for relevancy": the largest number of edges between a due concept and any concept of the current turn for it to count as related. `5` (`REVIEW_HOPS_ALL`) means **all**: any finite distance. |

Both are fields of `LearningPolicySettings`, so they persist in the single
`learning_policy_settings` row (`config_key = 'default'`, not per user: the hook's
agent-key user differs from the web user) through `getLearningPolicy` /
`saveLearningPolicyFunction`, and the web panel edits them with the same schema.
`reviewUrgency` ("Spaced-repetition urgency") stays a stored-but-unused weight;
the schedule below is fixed (see *Not in scope*).

## What counts as an exposure

An exposure is a moment the learner demonstrably engaged with a concept. The
last exposure of a concept is the latest of:

1. **Live turns** (`learning_live_feedback_turns`, the learner's own submitted
   turns, any session): the concept is in the turn's `taughtConceptIds` (the agent
   explained it to them) or in its `matches` with relationship `task_context`,
   `learner_evidence` or `misconception`. Time: `submitted_at` (else `created_at`).
   A `mention` is not an exposure: naming a concept is not engaging with it.
2. **Archived conversations**: each source message the published assessment
   cites for the concept (`learning_concept_assessment_cache.assessment`
   `demonstrated[].sourceId` and `gaps[].sourceId`), dated by
   `learning_semantic_index_messages.observed_at`.

Not exposures: a review the policy *offered* (the agent may not have used it; if it
did teach it, the next turn's `taughtConceptIds` records that), and a concept the
policy merely selected as a prerequisite.

Both sources are read by one query (`readReviewHistory`), scoped to the user,
only when the setting is on.

## Schedule

The interval after the last exposure is set by the concept's published mastery,
the same score the prerequisite fallback reads (`understandingPercent` of a
`ready`/`pending` assessment whose confidence is not `insufficient`):

| Mastery | Interval |
|---|---|
| 0-19 % | 1 day |
| 20-39 % | 2 days |
| 40-59 % | 4 days |
| 60-79 % | 8 days |
| 80-100 % | 16 days |
| no published score | 3 days |

A doubling (Leitner-style) ladder: the better a concept is understood, the longer
it can go unseen. An unscored concept gets its own middle interval because
**unknown is not zero mastery** (the house rule the prerequisite fallback already
follows): it is neither treated as the weakest learner's nor credited with a
strong learner's spacing.

A concept is **due** when `now - lastExposedAt >= interval`. Its urgency is the
overdue ratio `(now - lastExposedAt) / interval`.

## The review queue and the hop distance

The **queue** holds every due catalog concept, minus the exclusions below, ordered
by overdue ratio (highest first), then hop distance to the turn (nearest first,
unreachable last), then concept ID. Ties therefore resolve deterministically.

**Relatedness graph.** All curriculum edges restricted to the live catalog,
**both kinds** (`hard-prerequisite` and `related`), treated as **undirected**.
Why: the operator asked for "the large concept network graph", and relevance is
symmetric: a concept's prerequisite and its dependent are both related to it. In
the live data the prerequisite edges alone leave 219 of 674 catalog concepts
isolated (324 components); with both kinds there are no isolated concepts (64
components, the largest 285 concepts). Hop distance is the shortest path from the
concept to any concept of the turn (breadth first, so cycles are harmless).

The **turn's concepts** are every concept the agent matched in the current
message, any relationship including `mention`: a mention still says what the turn
is about.

**Selection.** The injected review is the first queue entry whose hop distance is
at most `reviewHops` (any finite distance at 5 = all). If the head of the queue is
out of range, the policy keeps walking the queue: otherwise one overdue concept
from an unrelated area would block every review forever, since nothing would ever
re-expose it. At most one review per turn. A concept with no path to the turn is
never related, even at "all": "all" means any distance, not "unconnected too".

**Exclusions** (never in the queue):
- concepts never exposed (no last exposure: new material, not review);
- concepts outside the live catalog;
- the turn's own concepts (they are being exposed right now);
- concepts the session's recent feedback suppresses (taught, demonstrated or
  partial in the last 12 turns / 24 h: `liveFeedbackPolicy`);
- concepts offered as a review in any of the learner's turns in the last 24 h
  (`learning_live_feedback_turns.review_concept_id`), so an ignored review is not
  re-offered on every turn;
- concepts already in this turn's guidance as a task target or prerequisite (the
  review moves on to the next queue entry).

## Interaction with the rest of the policy

- **Injection rate.** A review is a teaching intervention, so it never bypasses
  the ceiling: `injectionRate = 0` still means no intervention at all, and a turn
  over the rate/20-in-5 budget gets `no_context` whatever is due. A due related
  review does make a turn worth an intervention on its own, so a turn whose task
  concepts are all suppressed still injects (and spends budget) for the review.
- **Concept slots (<= 5).** Order: prerequisites, task anchor, review, other task
  concepts. Prerequisites get `5 - anchor - review` slots, so a count of 5 with an
  anchor and a review delivers 3. The review skips only prerequisites that keep a
  slot beside it (the first `5 - anchor - 1`); a prerequisite that would lose its
  slot to the review may itself be the review, and is then delivered once, with
  `role: "review"`.
- **4000-char ceiling.** Trimming removes from the end, sparing the anchor: other
  task concepts go first, then the review, then prerequisites.
- **Persistence and replay.** The delivered review is stored in
  `learning_live_feedback_turns.review_concept_id` (migration 0009) together with
  the `injected` decision; a turn that was not injected stores none.
- **Guidance format.** The review node carries `role: "review"`, `lastExposedAt`
  (date), `intervalDays`, `hops` and `relatedTo` (the nearest turn concept). With
  the setting on, the guidance ends with a `Spaced repetition: {...}` line (hops,
  due count, how many were related, the selected ID) and, when a review is
  delivered, one sentence telling the agent how to treat it.

## Edge cases

| Case | Result |
|---|---|
| Setting off | No query, guidance identical to before. |
| No matches in the turn | No turn concepts, nothing related, no review. |
| Only `mention` matches | Mentions define relevance; a related due concept is injected. |
| Due concept never exposed | Not in the queue. |
| Concept with no mastery | 3-day interval. |
| Unreachable concept | Never selected, even at hop 5 (all). |
| Head of queue out of range | Next related due entry is used. |
| Equal urgency | Nearer hop, then concept ID. |
| Cycles | Breadth-first distance; terminates. |
| Recently taught / demonstrated | Exposure is recent (not due) and the session suppresses it. |
| Offered but not taught in the last 24 h | Skipped. |
| Review equals a prerequisite that keeps its slot | Delivered once, as prerequisite; next review used. |
| Review equals a prerequisite that would lose its slot | Delivered once, as the review. |
| `injectionRate` 0 | `no_context`. |
| `injectionRate` 100 | Every turn may inject. |
| Guidance over 4000 chars | Review trimmed after other task concepts, before prerequisites. |
| History lookup fails | The whole turn fails open, as before. |

## Not in scope

- `reviewUrgency` does not scale the schedule; that would be a second knob on the
  same thing before the first has been observed.
- No per-user schedules or settings (one row, as for the rest of the policy).
- Mastery is not written; a review only changes the guidance.

## Test plan

1. **Unit (pure).** `learning-spaced-repetition.test.ts`: interval bands, due
   boundary, hop distances on a cyclic graph, unreachable components, queue order
   and ties, walking past an out-of-range head, every exclusion.
   `learning-teaching-default.test.ts`: slots, ordering, trimming, review vs
   prerequisite collision, off = unchanged.
2. **DB (learner_test).** `readReviewHistory` reads both exposure sources and the
   24 h offered set; `decideTurnInjection` stores `review_concept_id` once.
3. **Durable workflow experiment.** `learningSpacedRepetitionExperimentWorkflow`
   runs 30 prompts built from real turns, real concepts, real exposure history
   and real mastery from the `learner` DB (frozen in
   `fixtures/spaced-repetition-cases.json`). Each case seeds a fixture user on the
   database the workflow runs on, sends the turn through the live path
   (`beginLearningFeedbackTurn` then the shared submit path with the case's
   policy) and checks the decision, the review and the slots. Coverage: off; on at
   hops 1, 2, 3, 4, 5 (all) with a positive case at each existing distance and a
   negative case one below; due vs not due; never exposed; no mastery;
   unreachable; ties; cycles; suppression of recently taught and recently
   offered; injection rate 0 / 20 / 100; prerequisite fallback; guidance size; no
   matches; mention-only. The integration test runs the workflow on learner_test;
   the logged run exports a Langfuse dataset, one trace per prompt (session = run
   ID) and a pass score per prompt
   (`SPACED_REPETITION_LANGFUSE=true` on
   `packages/runtime-standalone/src/workflow/spaced-repetition-experiment.test.ts`).
   The DB tests are in `learning-spaced-repetition-db.test.ts`.
4. **Settings end to end.** Save through `saveLearningPolicyFunction`, read back
   through `getLearningPolicy`, and change the controls in the web panel
   (`apps/web/e2e/learning-policy.smoke.ts`).

## Findings from the live data (2026-10-23, read-only)

- Exposure sources: archive evidence 130 concepts / 268 events, live matches
  112 / 277, live taught 94 / 181; 218 exposed catalog concepts, 156 with mastery.
- Hop distances from real turns to exposed concepts run 1 to 22, plus unreachable.
  Nearest due related concept per real turn: 108 turns at 1 hop, 29 at 2, 5 with
  none reachable. So the default of 1 already finds a review for most turns.
- No real turn fits 3 prerequisites + anchor + review under 4000 chars; with a
  prerequisite count of 2, one does (3975 chars). The size-limit case therefore
  drops the review, as specified.

## Experiment results

Fixture `5f8f6778b7f2`, 30 cases, run `e0e2b9c4-3374-48af-b5c3-b6ef2c50aa25`:
30/30 pass, selected reviews at hops {1: 8, 2: 1, 3: 1, 4: 1, 5: 3, 9: 1}
(the 9-hop one only under "all"), largest guidance 3975 chars, 27 ms mean per
submit. Langfuse dataset `learner-spaced-repetition`, session = run ID, 30 traces,
each with a `spaced_repetition.pass` score.

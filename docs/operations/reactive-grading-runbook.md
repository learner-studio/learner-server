# Reactive grading: stall detection and recovery

Reactive grading turns indexed transcript messages into mastery readings:
**routing** (an indexed arrival is matched to concepts) → **admission** (a dirty
concept gets one of `concurrency` slots) → **assessment** (one live concept pass,
one paid model call per part) → **settlement** (the pass publishes its reading
and acknowledges its generation).

From 2026-10-30 19:23 to 2026-11-11 no reading was produced. Root causes, all fixed:

1. Four content-free chunks (477 hyphens each) were retained by the memory bank
   with zero vectors. The index classifier that should have marked them `empty`
   read `row.chunk_id` through a camel-casing query builder, got `undefined` for
   every row, and never marked one.
2. Routing verified a whole batch of 100 arrivals at once; one chunk without a
   vector failed the batch every minute, and admission only ran after a
   successful route, so nothing was admitted.
3. Every concept pass refused when ANY frozen chunk lacked a vector, before any
   paid call; the admission breaker treated each such failure as possibly paid
   and blocked the concept after one try (246 concepts).

## What isolates a bad item now

| Stage | One bad item | Recorded in | Retry |
|---|---|---|---|
| Index, no text | a chunk with no letter or digit that the bank holds no vector for is marked `empty` with its reason | `learning_semantic_index_chunks.status/error` | n/a (content-free) |
| Index, with text | a chunk WITH text and no vector stays `indexed`, flagged "Has text but the bank holds no vector for it…"; never emptied silently, so a broken extractor cannot drop real text. Flagged chunks do not count against the reconcile limit | `learning_semantic_index_chunks.error` | its arrival is held (next row) until an operator runs `acceptLearningVectorlessChunks` (below) |
| Routing | the arrival is HELD; the rest of the batch routes | `learning_reactive_route_holds` (reason, missing chunk ids, attempts) | 1, 5, 30, 120, 480 min, then the 6th attempt exhausts it (`next_attempt_at` NULL) |
| Routing, systemic | ≥10 chunks and >50% of a batch missing: the batch stays pending (the bank is down, not one item) | `learning_reactive_settings.last_error` and the step error, both with the cause | every minute |
| Assessment | up to 25 unverified chunks are recorded on the pass and it continues | experiment snapshot `counts.unverifiedChunkIds`; count in `learning_vector_turn_experiments.unverified_chunks` and in health | n/a |
| Admission | a pass that failed before any paid call costs nothing, so it never spends the breaker | `learning_reactive_admission.last_failure` (marker `before any paid model call`), `unpaid_failures`, `last_failed_at` | 5, 30, then every 60 min for as long as it fails; reported as stuck from the 3rd failure |
| Admission, paid | a pass that reserved a paid call and failed is blocked for review (never retried blindly) | `last_failure` "review original paid receipts" | operator |

## Signals

- `getLearningGradingHealth` (admin RPC) is `error` when any of these holds
  (`REACTIVE_STALL_HOURS` = 6):
  - indexed arrivals or dirty concepts have waited longer than the bound and that
    stage completed nothing in as long. A concept's wait starts when it FIRST
    became dirty (`learning_reactive_admission.waiting_since`), not at its latest
    arrival;
  - items that need an operator (concepts blocked at the breaker, concepts failing
    before any paid call 3+ times in a row, arrivals with exhausted holds) have
    been stuck longer than the bound AND work was due for longer than the bound
    with no reading: the learner has been active since then (arrivals with no
    gap of 6 h or more, the latest within 6 h, all after the last reading;
    `routing.activeWithoutReadingSince`), or work has waited in routing or
    grading past the bound. An idle learner is no evidence: a quiet night with
    blocked concepts stays a `warning`, and so does the first hour of the next
    morning. A blocked concept ages from its block (`last_failed_at`), else from
    when it first waited (`waiting_since`), never from its latest arrival;
  - at least 5 passes settled in the window but no reading has been produced for
    24 h;
  - (API only, where schedules run) no stall-check run has reached a verdict for
    60 min: the worker or its scheduler is down. A verdict is a completed run or
    one that failed with "Reactive grading stalled: …"; a run that crashed (a
    missing column, a DB timeout) checked nothing and does not count;
  - (API only) the latest stall-check run crashed without a verdict: "The
    reactive stall check itself is failing: <its error>".

  It is `warning` for the same operator items while readings still flow, for
  settling-without-readings under 24 h, and for passes graded without
  unverified chunks. It is `ok` when moving or idle (nothing waiting).
- The Learning page shows it under the hook-health alert (silent when `ok`).
- `learningReactiveStallCheckWorkflow`, scheduled every 15 minutes
  (`learning-reactive-stall-check`, only with `LEARNER_SCHEDULES_ENABLED=true`):
  a FAILED run, failed at step "Fail when grading has stalled", is the alarm; the
  step error carries the reason. The worker log gets `learning-reactive-stalled`.
  A stall-check run with no run or step update for 10 min is cancelled by the
  next schedule tick and a fresh one starts (`learning-reactive-stall-check-reclaimed`).
- **Delivery.** While the last finished stall check failed for you, the check
  itself is crashing, or no check has reached a verdict for 60 min, the next
  Claude/Codex prompt shows `⚠ Learner: Reactive grading alarm …` (or
  `… stall check is failing …`, `… is unmonitored …`) as a hook system message.
  It reaches the person only, never the model's context. It is carried by
  `beginLearningFeedbackTurn.alerts`, read by the API, so it works while the
  worker is dead. It is shown **once per state**, not on every prompt:
  `alertKey` names the state and when it began (the first failed run since the
  last completed one), the hook keeps the last key it showed in
  `<traceDir>/grading-alert.json` for every session on the machine, and shows an
  unchanged state again only after 24 h. A new state (it cleared and came back,
  or the watchdog joined) is shown at once.
- `getLearningReactiveConsolidation` lists `heldMessages`, `exhaustedMessages`
  and each hold with its reason and missing chunk ids.

```bash
# Health, as the owner's agent key (admin):
KEY=$(sed -n 's/^LEARNER_API_KEY=//p' /etc/learner/agent-key.env | tr -d "'\"")   # never echo it
curl -s -X POST http://127.0.0.1:3010/rpc/getLearningGradingHealth -H 'content-type: application/json' -H "x-api-key: $KEY" -d '{"data":{}}' | jq

# Stall-check runs and their failing step:
psql "$DATABASE_URL" -c "SELECT r.workflow_run_id,r.status,r.created_at,s.step_name,s.status,s.error::jsonb->>'message' AS reason
  FROM learner_workflow_runs r LEFT JOIN learner_workflow_steps s USING(workflow_run_id)
  WHERE r.workflow='learningReactiveStallCheckWorkflow' ORDER BY r.created_at DESC,s.created_at LIMIT 10"
```

## Recovery

`recoverLearningReactiveGrading` starts `learningReactiveRecoveryWorkflow`, deduplicated by
`requestId` (a repeated request returns the same run). Steps, each idempotent:

1. Reconcile indexed chunks without vectors, across the installation (the
   semantic index has no owner column): mark the content-free ones `empty` and
   flag the ones with text (`withContent` in the output). It refuses when more
   than 50 vectorless chunks are NOT already flagged, which means the bank is
   incomplete, not that the chunks are empty. Already-flagged chunks wait for an
   operator and never count against that limit.
2. Plan release of blocked concepts: blocked, releasable (last pass reserved NO paid
   call), paid (kept blocked), unknown, `exhaustedHolds`, `holdsAwaitingAccept`; and
   `estimatedPaidCalls`.
3. (apply only) Release concepts blocked before any paid call. The write re-checks
   "no paid call" itself, so a stale plan cannot release a paid one.
4. (apply only) Release arrivals that exhausted their routing retries: each gets a
   fresh retry budget. Holds waiting only on chunks flagged with text are left
   alone (`holdsAwaitingAccept`): a fresh budget would only re-exhaust them about
   10.5 h later and raise the alarm again with nothing fixed.
5. (apply only) Route pending indexed messages.
6. (apply only) Admit at the configured concurrency: recovery never raises the
   rate; the backlog drains at `concurrency` passes at a time, like normal operation.

Always dry-run first and read `plan.estimatedPaidCalls`:

```bash
REQ=$(cat /proc/sys/kernel/random/uuid)
curl -s -X POST http://127.0.0.1:3010/rpc/recoverLearningReactiveGrading -H 'content-type: application/json' -H "x-api-key: $KEY" \
  -d "{\"data\":{\"requestId\":\"$REQ\",\"apply\":false}}" | jq        # → {workflowRunId}
psql "$DATABASE_URL" -c "SELECT status,output FROM learner_workflow_runs WHERE workflow_run_id='<workflowRunId>'"
# Then, with a NEW requestId, "apply":true.
```

Held arrivals that exhausted their retries: fix the cause (or confirm the vectors
now exist), then `releaseLearningReactiveHolds {"onlyExhausted":true}`; each routes
again on the next pass with a fresh budget.

Chunks flagged "Has text but the bank holds no vector for it": read their text
(`learning_semantic_index_chunks` slice of `learning_semantic_index_messages.source_text`).
If it carries nothing to grade, accept them:
`acceptLearningVectorlessChunks {"chunkIds":[…]}` (admin, installation-wide). Each
becomes `empty` with "accepted as ungradable by an operator"; every hold on it with
no other chunk still awaiting an accept is deleted, so its arrival routes on the
next pass. Ids that were not flagged come back in `notFlagged`, untouched.
Re-indexing is not offered: the bank's extractor already kept no fact from that
exact text. If many chunks with real text are flagged, the extractor is broken:
fix it before accepting anything.

Concepts blocked after a PAID failure are not released by recovery: review the
receipts of the run in `last_run_id` first (rate limits, provider panics, empty
output), then `retryLearningReactiveTarget` per concept.

## The workflows under Pikku

Learner runs on Pikku. Every stage above is a Pikku workflow whose steps are
named, durable RPC steps; a failed step carries its reason in
`learner_workflow_steps.error`. The workflows are defined in
`packages/server/src/wirings/*.workflow.ts`; `packages/runtime-pikku/scripts/gen-wiring.ts`
copies them to `packages/runtime-pikku/src/generated/workflows/*.gen.ts` as
`pikkuWorkflowFunc`, and `pikku all` turns them into the step graph.

Run the Pikku CLI from `packages/runtime-pikku`, never via bunx:

```bash
cd packages/runtime-pikku
P="bun ../../node_modules/@pikku/cli/dist/bin/pikku.js"
$P meta workflows list                                       # every workflow id
$P meta workflows get learningReactiveRoutingWorkflow        # step graph JSON
$P meta workflows get learningReactiveConceptWorkflow
$P meta workflows get learningReactiveStallCheckWorkflow
$P meta workflows get learningReactiveRecoveryWorkflow
```

What they showed on 2026-11-11 (mode `distributed`, every step an `rpc` node):

| Workflow | Steps (name → RPC) |
|---|---|
| learningReactiveRoutingWorkflow | Admit already-routed concepts → dispatchLearningReactiveConceptsStep; Route pending indexed messages → routeLearningReactiveArrivalsStep; Admit affected concepts → dispatchLearningReactiveConceptsStep |
| learningReactiveConceptWorkflow | Coalesce related arrivals (sleep); Claim only the current dirty generation; Initialize immutable live vector run; Reuse top-50 original turn selection; (fan-out of assessment parts); Record full receipt coverage; Publish only validated final node estimate; Acknowledge only the assessed generation; Immediately refill rolling concept slots |
| learningReactiveStallCheckWorkflow | Measure reactive grading progress → measureLearningReactiveHealthStep (retries 2); Fail when grading has stalled → assertLearningReactiveMovingStep (retries 0) |
| learningReactiveRecoveryWorkflow | Reconcile indexed chunks without vectors → reconcileLearningIndexVectorsStep; Plan release of blocked concepts → planLearningReactiveRecoveryStep; branch on `apply`: Release concepts blocked before any paid call → releaseLearningReactiveUnpaidStep, Release arrivals that exhausted their routing retries → releaseLearningReactiveExhaustedHoldsStep (skips holds awaiting accept), Route pending indexed messages, Admit at the configured concurrency |

**Write every step call as a plain statement** (`const x = await workflow.do(...)`
or `x = await workflow.do(...)` onto a top-level `let`). The Pikku inspector
turns a call nested in an expression, such as `(await workflow.do(...)).field`,
into a `set` node holding the call as text: `pikku all` still reports clean,
the step function is never registered, and the run fails at that step with
"Function not found". `packages/runtime-pikku/tests/wiring.test.ts` fails on
both symptoms. Declarations inside an `if` are rejected outright (PKU641).

After adding a workflow or step: `bun scripts/gen-registry.ts`, then
`bun run generate` in `packages/runtime-pikku` (fails on any CLI diagnostic), or
on the dev box `flock /run/learner/prepare.lock bun scripts/runtime.ts prepare`.

The Pikku Console is not available: `pikku.config.json` leaves the `console`,
`rpc` and `workflow` scaffolds off (and `@pikku/addon-console` is pinned in the
root overrides but not installed), so read run state from the tables. The
health RPC and the stall-check workflow do not depend on the Console or the
graph; they work in a release build that ships neither.

Tests: `packages/runtime-pikku/tests/reactive-stall-check.test.ts` runs the
stall check as a queued run on pg-boss (its own schema,
`learner_pikku_boss_test_stall_check`, so no other consumer takes its step jobs).

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
| Index | a chunk the bank holds no vector for is marked `empty` with its reason | `learning_semantic_index_chunks.status/error` | n/a (content-free) |
| Routing | the arrival is HELD; the rest of the batch routes | `learning_reactive_route_holds` (reason, missing chunk ids, attempts) | 1, 5, 30, 120, 480 min, then exhausted (`next_attempt_at` NULL) |
| Routing, systemic | ≥10 chunks and >50% of a batch missing: the batch stays pending (the bank is down, not one item) | `learning_reactive_settings.last_error` | every minute |
| Assessment | up to 25 unverified chunks are recorded on the pass and it continues | experiment snapshot `counts.unverifiedChunkIds` | n/a |
| Admission | a pass that failed before any paid call retries after 0/5/30 min, its own budget only | `learning_reactive_admission.last_failure/last_failed_at` | 3 attempts, then blocked with the marker `before any paid model call` |
| Admission, paid | a pass that reserved a paid call and failed is blocked for review (never retried blindly) | `last_failure` "review original paid receipts" | operator |

## Signals

- `getLearningGradingHealth` (admin RPC): `status` is `error` when indexed
  arrivals or dirty concepts have waited longer than `REACTIVE_STALL_HOURS` (6)
  and that stage completed nothing in as long; `warning` for exhausted holds or
  blocked concepts; `ok` when moving or idle (nothing waiting).
- The Learning page shows it under the hook-health alert (silent when `ok`).
- `learningReactiveStallCheckWorkflow`, scheduled every 15 minutes
  (`learning-reactive-stall-check`, only with `LEARNER_SCHEDULES_ENABLED=true`):
  a FAILED run, failed at step "Fail when grading has stalled", is the alarm; the
  step error carries the reason. The worker log gets `learning-reactive-stalled`.
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

1. Reconcile indexed chunks without vectors: mark them `empty` (refuses above 50,
   which means the bank is incomplete, not that the chunks are empty).
2. Plan release of blocked concepts: blocked, releasable (last pass reserved NO paid
   call), paid (kept blocked), unknown; and `estimatedPaidCalls`.
3. (apply only) Release concepts blocked before any paid call. The write re-checks
   "no paid call" itself, so a stale plan cannot release a paid one.
4. (apply only) Route pending indexed messages.
5. (apply only) Admit at the configured concurrency: recovery never raises the
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
| learningReactiveRecoveryWorkflow | Reconcile indexed chunks without vectors → reconcileLearningIndexVectorsStep; Plan release of blocked concepts → planLearningReactiveRecoveryStep; branch on `apply`: Release concepts blocked before any paid call → releaseLearningReactiveUnpaidStep, Route pending indexed messages, Admit at the configured concurrency |

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

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
    stage completed nothing in as long, counted from the later of its last
    completion and the last switch-on of Learning or assessment
    (`config.switchedOnAt`), so a backlog built while it was off is not red the
    minute it is back (it goes red 6 h later if still nothing completes). A
    concept's wait starts when it FIRST became dirty
    (`learning_reactive_admission.waiting_since`), not at its latest arrival;
  - **the stuck rule.** Work is due for a stuck item (a concept blocked at the
    breaker, a concept failing before any paid call 3+ times in a row, an arrival
    with an exhausted hold) once a DUE arrival exists that is newer than both the
    moment the item got stuck and the last service. Service is a reactive reading
    or a settled pass (a pass with no new evidence legitimately publishes
    nothing; settling without readings has its own 24 h rule below), floored at
    when Learning or assessment was last switched on (`config.switchedOnAt`,
    stamped by `configureReactive`), so arrivals from while it was off are not
    owed the moment it is back. A manual reading serves nothing. A due arrival is
    one routed to at least one concept, or one not routed under the current
    revision (pending or held). A message that matched no concept is not grading
    work, whoever wrote it, and is not due.
    The alarm goes red when the oldest due arrival has gone unserved for 6 h of
    accumulated due-arrival time (each gap between due arrivals, and the time
    since the last, capped at 30 min): short sessions add up across days. This is
    not the learner's working time: a night with no due arrival adds at most 30
    min, but each due arrival overnight (a concept-matching backfill) adds up to
    30 min. A retry of a stuck item writes no arrival, so it never counts.
    **The light-learner backstop** (`REACTIVE_UNSERVED_BACKSTOP_HOURS` = 48,
    `REACTIVE_BACKSTOP_RETURN_HOURS` = 12) goes red sooner for someone who
    prompts once a day: the oldest unserved arrival that is the stuck items' OWN
    work (unrouted or held, or routed to a concept that is itself blocked or
    retrying, through `learning_reactive_targets`) is 48 h old, and the learner
    came back: another such arrival at least 12 h after it has itself gone 6 h
    unserved. One prompt a day goes red after two days. An unserved arrival at
    the end of a session is NOT evidence on its own: a matched pass can publish
    nothing, and nobody waits on it while the learner is away. Replayed on dev
    09-08..11-11 with every matched arrival counted as a stuck item's (the worst
    case), the backstop without the came-back requirement read 2 false red
    episodes (09-19, 10-12..10-20); with it, none, and the 10-30 stall is still
    red at 10-31 02:30.
    With assessment OFF no reading can be produced: blocked and retrying concepts
    stay a warning, and only exhausted holds can go red, served by routing (the
    last route) instead of a reading; only unrouted or held arrivals are their work.
    Health reports the evidence as `routing.unservedSince`,
    `routing.unservedActiveMinutes`, and for the backstop
    `routing.stuckUnservedSince` and `routing.stuckReturnedAt`; the cap is `REACTIVE_ACTIVE_GAP_MINUTES`
    (99.6% of dev's gaps between arrivals are 30 min or less). A blocked concept is
    stuck from its block (`last_failed_at`), else from when it first waited
    (`waiting_since`). A concept retrying unpaid failures is stuck, not waiting
    work, so it never feeds the "waited longer than the bound" rule above;
  - at least 5 passes settled in the window but no reading has been produced for
    24 h (floored at the last switch-on too);
  - (API only, where schedules run) no stall-check run has reached a verdict for
    60 min: the worker or its scheduler is down. A verdict is a completed run or
    one that failed with an error STARTING "Reactive grading stalled: …"; a run
    that crashed (a missing column, a DB timeout) checked nothing and does not
    count. The 60 min run from the later of the last verdict and the alarm's
    activation, so a fresh install is not "unmonitored";
  - (API only) the latest stall-check run crashed without a verdict: "The
    reactive stall check itself is failing: <its error>".

  It is `warning` for the same operator items without that evidence, for
  settling-without-readings under 24 h, for passes graded without
  unverified chunks, and for **routing that matches nothing**: at least 20
  arrivals routed in the last 24 h (`REACTIVE_NO_MATCH_MIN_ROUTED`,
  `REACTIVE_NO_MATCH_HOURS`), none to a concept, while the 30 days before
  (`REACTIVE_NO_MATCH_BASELINE_DAYS`) routed at least 20 and matched at least 5%
  of them (`REACTIVE_NO_MATCH_BASELINE_SHARE`). That is a catalog or bank
  embedding mismatch, a threshold change or empty hits: no arrival is due, so no
  other rule can see it. Health reports the counts as `routing.matching`.
  Replayed over dev's routes 09-08..11-11 by route time: no false warning for
  any minimum of 10, 20 or 50 and any share of 5%, 10% or 20% (the lowest
  matched share in any 24 h window with 20+ routes was 10.8%; the longest run of
  unmatched routes was 399, on 10-22, inside windows that also matched); a
  matcher killed at 10-21, 10-27 or 11-10 noon warns after 23.0, 20.8 and 13.2 h.
  The baseline is 30 days, not 7: the 10-30 outage left a week with no routes,
  and a 7-day baseline missed the 11-10 case. It is a warning, not red: a learner
  who really stops touching catalogued topics for a day looks the same. It is
  still told to the person at once: the next prompt shows `⚠ Learner: Reactive
  grading: Routing matched no concept: …`, keyed `nomatch`, and the hook repeats
  it every 24 h while it lasts (no check fails, so nothing else would say it).
  It is `ok` when moving or idle (nothing waiting).

  **What reads idle, not red.** The check sees only arrivals. A hook that stopped
  submitting, or an indexer that is down, produces no arrival, so health reads
  idle (`ok`). Check those with the hook-health alert on the Learning page and the
  indexer's own status, not with this check.

  **A curriculum purge** deletes the purged concepts' admission rows and
  readings. Before it does, it keeps the latest settle and reading among them in
  the settings config (`purgedLastSettledAt`, `purgedLastReadingAt`; a settings
  save keeps them), and health reads "served" from the later of those and the
  live rows, so a purge never makes the check red.
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
  `beginLearningFeedbackTurn.alerts` and, for a hook without live feedback (the
  default), by `getLearningHookContext.alerts`; both are read by the API, so it
  works while the worker is dead. A session where the person turned Learning off
  calls no server and shows nothing; the alert is not lost, because the hook
  records a key only when it shows it, so the next session that is on shows it.
- **Partial stalls.** Items needing an operator while other concepts still
  produce readings usually stay a `warning`. They go red only when nothing at
  all was served while the learner kept coming back to the stuck items' own
  work (for example, every prompt for two days touched only the one blocked
  concept): that is genuinely ungraded work. Once the oldest of
  them has been stuck for more than 3 days (`REACTIVE_OPERATOR_REMINDER_DAYS`),
  the next prompt shows `⚠ Learner: Reactive grading has needed an operator
  since …` with the same actions as the warning, keyed `stuck:<oldest stuck
  time>`, so it repeats every 24 h until that item is cleared. Assessment-off
  left-overs are reminded too: they need an operator as much. It reads the
  stall check's latest measurement, and only one at most 60 min old: an older
  one may name items cleared since (with schedules off, nothing measures). Three days is
  longer than a weekend away and far short of the 12 days the 10-30 stall went
  unseen. While you are red, the alarm speaks instead. It is shown **once per state**, not on every prompt:
  `alertKey` names each state and when it began (the first failed run since the
  last completed one), parts joined by `|`; the hook keeps when it last showed
  each part in `<traceDir>/grading-alert.json` for every session on the
  machine (parts unseen for 7 days are dropped), and shows the alerts when any
  part is new or was last shown 24 h ago. A new state (it cleared and came back,
  or the watchdog joined) is shown at once; a reminder shown minutes before a
  red episode is not shown again when the episode ends.
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
   "no paid call" itself, so a stale plan cannot release a paid one. A released
   concept waits from the release (`waiting_since` reset, `unpaid_failures` 0), so
   it does not read as days-old waiting work before its first pass settles.
4. (apply only) Release arrivals that exhausted their routing retries: each gets a
   fresh retry budget. Holds with any missing chunk flagged with text are left
   alone (`holdsAwaitingAccept`, which counts mixed holds too): they cannot route
   until that chunk is accepted, so a fresh budget would only re-exhaust them about
   10.5 h later and raise the alarm again with nothing fixed. A hold with no
   missing chunk is always released.
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

### Releasing many paid-blocked concepts (operator procedure)

`retryLearningReactiveTarget {"conceptId":…}` is the only release for a paid
block: it resets `attempts`, clears `last_failure`, restarts `waiting_since`, and
runs the dispatcher. It never raises concurrency; released concepts queue by
`last_notified_at`, so old blocked ones are admitted ahead of fresh work. Each
re-graded concept costs about `plan.partsPerPass` paid calls. No hand SQL is
needed. For a large set:

1. **Classify the receipts first** (ids and system errors only, never learner
   text). A transient cause (429 rate limit, codex panic/exit code, empty output,
   a reservation with no receipt because the process died) is safe to retry; a
   cause that repeats on every concept is not, so fix it before releasing:

   ```sql
   SELECT r.created_at::date, rc.receipt->>'status' st,
          left(regexp_replace(coalesce(rc.receipt->>'error',''),'[0-9a-f-]{36}','<id>','g'),100) err, count(*)
   FROM learning_reactive_admission a JOIN learner_workflow_runs r ON r.workflow_run_id=a.last_run_id::text
   JOIN learning_vector_turn_assessments v ON v.experiment_id=(r.input::jsonb->>'dispatchId')::uuid
   LEFT JOIN learning_concept_assessment_receipts rc USING(run_id)
   WHERE a.attempts>=3 AND a.last_failure LIKE '%review original paid receipts%' GROUP BY 1,2,3 ORDER BY 1,4 DESC;
   ```
   A codex error that only says `exited with code 1` hides its cause in the event
   JSON: `substring(receipt->>'error' from '"type":"(?:error|turn.failed)"[^}]{0,200}')`.
2. **Back up** the rows (mode 600) and keep a restore:

   ```bash
   umask 077; F=/var/lib/learner/backups/unblock-paid-$(date -u +%Y%m%dT%H%M%SZ).json
   psql "$DATABASE_URL" -At -c "SELECT json_agg(row_to_json(a)) FROM learning_reactive_admission a
     WHERE attempts>=3 AND last_failure LIKE '%review original paid receipts%'" > "$F"
   # Restore (re-blocks only rows that are idle and still unsettled), via a FILE so psql interpolates :'backup':
   #   UPDATE learning_reactive_admission a SET attempts=b.attempts,last_failure=b.last_failure,last_failed_at=b.last_failed_at,
   #     waiting_since=b.waiting_since,unpaid_failures=b.unpaid_failures,last_run_id=b.last_run_id
   #   FROM jsonb_populate_recordset(NULL::learning_reactive_admission, :'backup'::jsonb) b
   #   WHERE a.user_id=b.user_id AND a.session_id=b.session_id AND a.dispatch_id IS NULL AND a.captured_generation<b.requested_generation;
   #   psql "$DATABASE_URL" -v backup="$(cat "$F")" -f restore.sql
   ```
3. **Plan** with `recoverLearningReactiveGrading` (`apply:false`): it should show
   `blockedPaid` = the set and `releasableUnpaid` empty. `apply:true` releases none
   of them, so it is not part of this procedure.
4. **Pilot** one concept of each failure class, then release in batches of about
   40, the next batch only when fewer than 10 released concepts are still waiting
   or running, so ordinary arrivals and other Codex users are not starved:

   ```bash
   while read -r cid; do
     curl -s -o /dev/null -w "$cid %{http_code}\n" -X POST http://127.0.0.1:3010/rpc/retryLearningReactiveTarget \
       -H 'content-type: application/json' -H "x-api-key: $KEY" -d "$(jq -nc --arg c "$cid" '{data:{conceptId:$c}}')"
   done < batch.txt
   ```
   Concept ids come from `learning_reactive_targets` joined on `session_id`.
5. **Stop** when released concepts fail again with a paid failure (5 or more) or
   keep failing before any paid call: that is a systematic cause, not a transient.

A released concept whose earlier paid attempt holds identical evidence, prior and
prompt revision is handled by that attempt's receipt (the reservation guard keys on
evidence, not on the run):
- **Completed with an estimate:** reused (`unchanged`), no call.
- **Failed on the provider side** (`LLM_ERROR` such as "codex CLI exited", a
  timeout, HTTP 429/5xx, `LLM_PARSE_ERROR`, the generic telemetry error;
  `isProviderFailure`): ONE fresh paid attempt, under the scope key plus
  `:retry`. Nothing usable was bought and the outcome is known, so this is not
  paying twice for an unknown outcome. 1,566 holders of the 10-22..10-27 outage
  are this kind.
- **Failed on the evidence** (a validator rejection such as an inexact quote or
  an unknown concept), or the fresh attempt failed too: a zero-cost `failed`
  receipt ("Identical evidence already failed a paid grading", `reusedRunId`, 0
  tokens). In a cold pass a failed middle slice is skipped and the last
  completed part is published; when the failed part is the last one, the pass
  settles with no new reading. That slice is not graded again until its
  evidence changes (a new input hash).
- **No receipt, or one with no reusable estimate that is not a failure**
  (`uncertain`, a typed decision): the outcome for this evidence is unknown. The
  part is `uncertain` and the pass goes to the paid breaker (`blocked`): review
  the earlier run before releasing it.

Before round 7 every non-completed holder gave `uncertain`, the pass failed
before any paid call, and the unpaid backoff retried it every 5/30/60 min for
ever while health sat at warning.

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

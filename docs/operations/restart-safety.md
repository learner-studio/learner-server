# Restart safety

Owner requirement, 2026-11-11: restarts must not affect any work. The short
form is in `CLAUDE.md` ("Restart-proof"); this file is the detail every
author and every reviewer works from.

## Why this exists

On 2026-11-11 service restarts on the dev box killed 20 reactive grading
passes mid-call. Each left a reservation with no receipt; the workflow then
refused to repeat the call, failed, and after three attempts blocked the
concept until a person released it. The passes were Pikku workflows, but the
paid step was not self-healing. The dev box reloads `learner-api` and
`learner-worker` on every imported-file change, so a restart is a normal
event, many times an hour, not an incident.

## The rule

A process may die at any instruction. After it comes back, with no operator
action:

1. every piece of work that was accepted is completed;
2. every effect happens once;
3. nothing is left in a state only a human can leave, unless the spec names
   the human decision it is waiting for.

## How to build it

| Need | Use | Not |
|---|---|---|
| Work that outlives a request | a Pikku workflow; one durable step per unit of effect | a promise left running after the response, a `setInterval` loop |
| Deferred or fan-out work | a Pikku queue job that starts a workflow | an in-memory array or map of pending items |
| Periodic work | a Pikku schedule that starts one run per period, keyed by the period | a timer in a long-lived process |
| A long external call (LLM child process) | a reservation row with owner, lease and heartbeat; the child writes its result to a per-attempt durable location; a restarted worker adopts a finished result, waits for a live child, re-runs when the owner is dead and no result exists | "reserved, no receipt" treated as final |
| A metered remote call whose outcome may be unknown | declare the backend metered; reconcile with the provider by idempotency key before repeating | a blanket never-repeat rule applied to local or flat-rate backends |
| One effect per run | an idempotency key or an atomic claim in the same transaction as the effect's record | check-then-act across two statements |
| Stopping | on SIGTERM stop claiming, finish or hand off in-flight steps inside the unit's stop timeout | exit at once |
| Starting | reclaim orphaned reservations, leases and runs on boot and on a timer | a manual recovery RPC as the only way back |

Scripts under `scripts/` that run for more than a few seconds or spend calls
(simulations, backfills, releases) follow the same rule: resumable by run id,
safe to kill and start again.

Exempt: pure reads, and a write that is one database transaction with no
outside effect.

## The test every change ships

A crash-recovery test in the Pikku runtime tier
(`packages/runtime-pikku/tests/`) that:

1. starts the real worker as a child process against the checkout's own test
   database, with a fake backend slow enough to be caught mid-step;
2. kills it mid-step, once with SIGKILL and once with SIGTERM;
3. starts it again and waits;
4. asserts: the run completed; exactly one effect row; no row in a blocked,
   failed-awaiting-operator or orphaned-reservation state; no operator call
   was made.

Kill at more than one point when a step has more than one write (before the
reservation, between reservation and result, between result and publish).

Shared pieces, reuse them, never copy them:

- the lease (owner, heartbeat, provable owner death, takeover budget, audit
  rows): `driveAttempt` in `packages/core/src/lib/learning/llm-attempt-lease.ts`;
- the durable, adoptable CLI call: `runDurableCliCall` in
  `packages/llm/src/lib/cli/durable-cli-call.ts` (the lease passes it as
  `durable`);
- repeat or not: `repeatIsFree` in `packages/llm/src/lib/llm/backend-cost.ts`;
- the crash harness (fake slow counting `codex`, a killable child, `until`):
  `packages/llm/src/lib/cli/testing/crash-harness.ts`; the database is
  `ownTestDatabaseUrl(kind)`. Worked examples:
  `packages/runtime-pikku/tests/restart-recovery.test.ts` (the real worker,
  running the assessment workflow and the drift-panel workflow).

## Reviewer checklist

Copy this table into the review report. CLEAN requires every row to be
"pass" or "n/a" with the reason. A reviewer verifies by running or reading
the crash test and by killing the process in a throwaway copy, not by
reading the author's report.

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Every unit of work that outlives a request or has an outside effect is a step of a Pikku durable workflow (or a queue job that starts one). List them. | | |
| 2 | No timers, in-memory queues, fire-and-forget promises or detached scripts hold such work. `rg` for `setTimeout`, `setInterval`, `void ` + async call, module-level arrays/maps of pending work in the changed files. | | |
| 3 | Each step is idempotent: name its key or claim. Re-running it by hand in a test yields one effect. | | |
| 4 | SIGKILL mid-step, restart: work completes with no operator action. Reproduced by the reviewer. | | |
| 5 | SIGTERM mid-step, restart: same. | | |
| 6 | Reservations and leases have an owner, expiry and heartbeat; an expired one is reclaimed on boot and periodically. | | |
| 7 | A result produced after the owner died is adopted, not discarded and not paid for again. | | |
| 8 | No terminal state waits for a human unless the spec names the decision. List every status value the change can write and who or what moves a row out of it. | | |
| 9 | "Never repeat" is used only for a backend declared metered and remote. | | |
| 10 | Schedules start one run per period under concurrent starts and a restart at the period boundary. | | |
| 11 | Health and alarms: a restart that healed raises no alarm; a restart that did not heal does. | | |
| 12 | The crash-recovery test exists, is in the pre-push suite, and fails when the reclaim or idempotency logic is removed (mutation checked). | | |

## Reduction pass

Owner requirement, 2026-11-11: minimal total code and tests, fewest
functions, workflows that reuse each other by Pikku's own constructs. Every
reviewer does this after the checklist above and reports it as a table. The
reviewer stays read-only: it tries each reduction in its throwaway copy, runs
the suite there, and reports only reductions that keep it green. The author
applies them. CLEAN requires an empty table.

| # | Look for | How |
|---|---|---|
| R1 | Two functions, steps or queries that do the same thing | `rg` the changed concepts across `packages/`; name the survivor |
| R2 | A hand-rolled mechanism Pikku already provides (retry, schedule, queue, workflow resume, step idempotency, RPC invoke, scopes) | name the Pikku construct that replaces it |
| R3 | A workflow that re-implements steps of another instead of starting it as a sub-workflow or invoking its function | name the workflow to reuse |
| R4 | A private copy of the reservation/lease/reclaim, idempotency, LLM-call or crash-test harness code | point at the shared one; if none exists yet, extract once and move every caller |
| R5 | Functions with one caller that add no boundary; options and parameters no caller varies; exports nobody imports | inline or delete |
| R6 | Dead branches, compatibility shims, code a change left unused | delete, callers included |
| R7 | Tests that assert the same behaviour at two tiers, or that a mutant shows are redundant (delete the test: the suite still kills every mutant) | keep the lowest tier that fails for it |
| R8 | Copied fixtures, seeds and harness setup | one shared helper |

Report: lines and function count of the changed area before and after the
proposed reductions (`git diff --stat` plus an `rg -c "^(export )?(async )?function |=> \{"`
count is enough), and each reduction as file, lines, replacement.

A reduction never removes a restart-safety property or a test that is the
only one failing for some mutant.

## Deploys

A deploy is a restart plus new code and schema, and the same rule holds: it
never leaves a dead server behind an active unit, a stale generated file, or
an unapplied migration.

- `bun run deploy` (`scripts/deploy.ts`) drains first, so no run resumes on
  a changed workflow graph: stop the API (no run admitted over HTTP), pause
  the schedules with Pikku's own mechanism (`packages/runtime-pikku/src/drain.ts`:
  the recurring tasks' pg-boss schedules are unscheduled, as
  `PgBossSchedulerService.stop()` does, and every worker start schedules
  them again), and wait, re-pausing on every poll, until no run is in flight
  and no queue job is due or active, for `LEARNER_DEPLOY_DRAIN_SECONDS`
  (default 600; 0 skips the drain). A drain that times out or fails lists
  the runs and queues still busy, restarts the worker (which schedules again)
  and starts the API on the code they ran, waits for their health, and exits
  1: nothing was pulled. No pause outlives a unit restart, so a deploy killed
  mid-drain leaves a paused state only until the worker next starts; the
  transient unit below restarts it at once.
- Then the deploy moves `/root/learner`: stop both units, fast-forward pull,
  `bun install --frozen-lockfile`, clear the git-ignored
  `packages/runtime-pikku/.pikku`, start both units, then wait for
  `/api/health` and a worker heartbeat newer than the start. A failed install
  puts the checkout back on the HEAD it started from (`git reset --keep`) and
  installs that lockfile again; SIGHUP and SIGINT are ignored from the stop to
  the start; the units are started and their health awaited even after a
  failure, which then exits non-zero. From an interactive session, run it as
  the transient unit in the header of `scripts/deploy.ts` (`systemd-run
  --wait --collect --unit learner-deploy --working-directory=/root/learner
  --setenv=HOME=/root -p 'ExecStopPost=…' bun run deploy`). Its
  ExecStopPost restarts the worker and starts the API unless the deploy
  exited 0 (`$EXIT_STATUS`), so a deploy that is SIGKILLed, OOM-killed,
  stopped with `systemctl stop learner-deploy` or throws never leaves the API
  stopped or the schedules paused; after a failure the deploy handled
  itself, it costs one more worker restart. HOME, because
  a transient unit has none, so without it git skips the credential
  helper in `/root/.gitconfig` and bun installs into a cold
  `node_modules/.bun-cache` while both units are stopped): an ssh hang-up re-sends SIGHUP to the job's whole
  process group, which kills a running `git pull` or `bun install` child, and
  a pull killed mid-checkout can leave a partial tree.
- `scripts/runtime.ts` runs `prepare` (codegen, under
  `/run/learner/prepare.lock`, which it takes itself: the units' `ExecStartPre`
  and any manual run must not wrap it in `flock`, or the inner flock waits on
  its parent forever; `tests/runtime-supervise.test.ts` runs the units' line) and `migrate` (pending migrations applied)
  before every server start. A hot reload re-runs `prepare` only, one reload
  at a time: a draft migration saved in the checkout never reaches the DB. It supervises
  the server: any exit it did not ask for, a load failure included, exits the
  wrapper non-zero, so systemd's `Restart=on-failure` restarts the unit
  (2026-11-11: a `git pull` left `functions.gen.ts` stale, both
  `bun --watch` children died on load, and both units stayed active with
  nothing on :3010 for 27 minutes; a migration on main and unapplied served
  500s). Test: `tests/runtime-supervise.test.ts`.

## Known gaps

Track open exposure here until closed; remove the line with the fixing
commit.

- A metered backend's call whose owner died is never repeated and its result
  is not adopted: the part stays `uncertain` for review (by design until a
  provider reconciliation by idempotency key exists).
- Until `deploy/systemd/learner-worker.service` is installed on a host, a
  `systemctl restart` kills the CLI child with the worker's control group: the
  call is run again (free on a local CLI) instead of adopted.
- The incremental-grading experiment's `settle` still stamps a call
  `uncertain` when its queue job ended (both pg-boss attempts) with a
  reservation and no receipt; the call itself (`executeIncrementCall`,
  `executeReviewCall`) is on the shared fence.
- Blind probes on the submit path: an undecided turn when the agent never
  retries, and a `delivered` probe the agent never received (review7
  S4; lane `learner-measurement` with `restart-safe`).
- Mastery notifications need nothing: a view over immutable readings and an
  insert-once feedback row (exempt above); the client's `since` cursor is in
  learner-desktop.
- An attempt taken over 3 times (a call that kills its worker every time)
  stops for a person: `learning_llm_attempt_leases` with `takeovers >= 3`.

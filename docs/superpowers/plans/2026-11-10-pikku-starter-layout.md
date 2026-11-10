# Learner on the Pikku Starter Layout: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the Learner backend onto the folder layout and code conventions of `pikkujs/starter-template` (native `pikkuFunc` functions in `packages/functions`, root `pikku.config.json`, `db/postgres` migrations, generated `packages/functions-sdk`) with one runtime, and without changing the wire contract that learner-desktop, the CLI hook and the uploader depend on.

**Architecture:** Strangler migration inside one repo. Pikku is first upgraded in place to the template's versions, then the new `packages/functions` grows beside `packages/server` + `runtime-pikku` until every function, wiring and workflow has moved, then the old packages are deleted. A spike (Task 1) decides how durable queues and workflows run, because the template's `pikku dev` and standalone entry both construct in-memory queue, workflow and scheduler services.

**Tech Stack:** Bun 1.4, Pikku (`@pikku/cli` 0.12.206, `@pikku/core` 0.12.152, `@pikku/kysely` 0.13.41), Postgres 17, Kysely, pg-boss, Better Auth + apiKey plugin, Zod 4.

**Spec:** this document's "Delta" section, derived from `pikkujs/starter-template@8eee858` (2026-11-09) and `/root/learner@1dac0de`. Background: `MIGRATION-LOG.md` "Two runtimes".

## Decisions the operator must make before Task 2

1. **Drop "installs without Pikku".** Amendment 2 (2026-10-21) required it. This plan removes `runtime-standalone`, so Learner then requires Pikku. Record the reversal in `MIGRATION-LOG.md`.
2. **Where domain code lives.** The template keeps all backend code in `packages/functions/src` (`lib/`). Learner has ~40k lines in `packages/core` + `packages/llm`. **Recommended:** keep both as workspace packages that `packages/functions` imports. Moving them under `srcDirectories` makes the Pikku inspector parse every file on each `pikku all`, and exposes all of them to the inspector traps listed under Global Constraints.
3. **What the desktop pins.** Today it pins `packages/contract/contract.json`. The template generates `surface.pikku.json` (per-function contract hashes). **Recommended:** keep `packages/contract` as the source of the client-facing schemas (functions import them), and keep `contract.json`. Switching the desktop to `surface.pikku.json` is a later change in learner-desktop.
4. **Frontend.** Moving `apps/web` (Vite SPA) to the template's `apps/app` (TanStack Start SSR, `packages/theme`, `m.*()` i18n, oxlint) is a separate subsystem and gets its own plan. This plan keeps `apps/web` and points its typed client at `packages/functions-sdk` only where that is a drop-in replacement.

## Delta: starter template vs Learner today

| Template path | Role in template | Learner today | Action |
|---|---|---|---|
| `pikku.config.json` (root) | One config: `srcDirectories`, `outDir: packages/functions/.pikku`, `clientFiles` → functions-sdk, `db.engine`, `scaffold`, `environments` | `packages/runtime-pikku/pikku.config.json`, everything scaffolded off | Move to root; `db.engine: "postgres"`; scaffold `rpc`, `workflow`, `console` on |
| `tsconfig.json` (root) | The backend's tsconfig; includes `packages/functions/{src,test}` | Root `tsconfig.json` covers every package | Keep root as the workspace typecheck; add the backend include |
| `bunfig.toml` | Pins the hoisted linker | Exists | Compare and align |
| `packages/functions/src/functions/*.function.ts` | `pikkuFunc` / `pikkuSessionlessFunc` with exported Zod `input`/`output` | 300 `defineFunction`/`defineSessionlessFunction`/`defineVoidFunction`/`defineWorkflow` in `packages/server/src/functions/**` | Codemod and move (Task 6) |
| `packages/functions/src/application-types.d.ts` | `UserSession`, `Config`, `SingletonServices`, `Services` | `packages/runtime-pikku/src/application-types.d.ts` + `packages/server/src/services.ts` types | Merge |
| `packages/functions/src/config.ts` | `pikkuConfig` | `packages/server/src/config.ts` | Port; reads `/etc/learner/*.env` keys |
| `packages/functions/src/services.ts` | `pikkuServices` + `pikkuWireServices`; uses injected `kysely` | `packages/server/src/services.ts` + `runtime-pikku/src/services.ts` + `transport.ts` | Merge; durable services per Task 1 |
| `packages/functions/src/auth.ts` | `pikkuBetterAuth` factory | `packages/server/src/auth.ts` + `runtime-pikku/src/auth.ts` + `require-api-key.ts` | Port with the apiKey plugin on Postgres |
| `packages/functions/src/middleware/*.middleware.ts` | CORS, analytics origin | Session resolution in `runtime-pikku/src/adapt.ts`, access checks in `packages/server/src/runtime/invoke.ts` | New `session.middleware.ts`; access via Pikku permissions |
| `packages/functions/src/variables.ts`, `flags.ts` | Declared variables and feature flags | `packages/server/src/runtime/variables.ts` | Port |
| `packages/functions/src/virtual-users.ts`, `test/scenarios`, `test/steps`, `test/features` | Scenario tests via `pikku scenario run` | Bun tests (co-located), `scripts/gate.ts` | Keep bun tests; scenarios optional, not in this plan |
| `packages/functions/src/addons/*.addon.ts` | `@pikku/addon-admin` | none | Skip |
| `packages/functions-sdk` | Generated RPC map, fetch, React Query client | Hand-written typed client in `packages/contract` | Add (generated); contract stays (Decision 3) |
| `db/<engine>/NNNN-*.sql`, `db/annotations.ts`, `db/<engine>-dev-seed.sql` | `pikku db migrate` / `generate` / `types` | 17 files in `packages/server/src/db/migrations`, Kysely `Migrator` ledger, kysely-codegen types | Move to `db/postgres/`; baseline the Pikku ledger (Task 3) |
| `emails/`, `knowledge/` | Email templates, knowledge base | none | Skip |
| `scripts/dev.mjs` | Spawns `bunx --bun pikku dev` + frontend | `scripts/runtime.ts` + `bun --watch` | Replace (Task 9) |
| `surface.pikku.json` | Generated API surface | `packages/contract/contract.json` | Generated alongside (Decision 3) |
| `.github/workflows/{ci,checks}.yml` | Build, lint, `pikku deploy apply -p standalone --runtime bun`, boot smoke | `.github/workflows/ci.yml` (typecheck + suite + throwaway Postgres) | Add `pikku all` + `pikku validate` + standalone build + boot smoke |
| `apps/app`, `packages/theme` | TanStack Start + shadcn + theme tokens | `apps/web` | Separate plan (Decision 4) |
| — | — | `packages/runtime-standalone`, `packages/runtime-pikku`, `packages/server`, `scripts/runtime.ts`, `scripts/gen-registry.ts`, `runtime-pikku/scripts/{gen-wiring,generate}.ts`, `registry.gen.ts` | Delete (Task 10) |
| — | — | `clients/hook`, `clients/uploader`, `packages/contract`, `packages/core`, `packages/llm`, `vendor/hindsight`, `deploy/` | Keep |

**Two facts from the template that shape the plan:**
- `@pikku/cli` 0.12.206 `pikku dev` constructs `InMemoryWorkflowService` and `InMemorySchedulerService` (`dist/src/functions/commands/dev.js:83,214`), and the standalone deploy entry also constructs `InMemoryQueueService` (`@pikku/deploy-standalone` 0.12.30 `dist/adapter.js:458-460`). Learner needs pg-boss queues and Postgres-durable workflows that survive `kill -9`. `services.ts` receives these as `existingServices` and may replace them, but nothing in the template proves that works. Task 1 proves it or stops the plan.
- The template supports Postgres: `db.engine` accepts `postgres`, migrations live in `db/postgres`, the URL comes from `createConfig`'s `postgresUrl`, and the CLI's PGlite shadow DB always loads `pgcrypto` and `vector`.

## Global Constraints

- Wire contract unchanged: `POST /rpc/<name>` with body `{ "data": <input> }`, header `x-api-key`, non-2xx body `{ "message": … }`, 500s opaque.
- `GET /api/health` answers `product: 'learner-server'`, `contract: 1`, and 503 when the database is unreachable.
- Every RPC name stays its current export name. All 300 definitions keep their input/output schemas and scopes.
- Privilege always comes from the owning user (`sessionForUser`), never from the API key or Pikku's own session mapping.
- Calls nested inside a function keep the caller's session.
- Schedules run only when `LEARNER_SCHEDULES_ENABLED=true`, and only in the worker process.
- The admission pause file `/run/learner/learning-admission-paused` keeps working: present means no new learning work is admitted.
- Workflow state stays in `learner_workflow_runs` / `learner_workflow_steps`; in-flight runs started by the current Pikku runtime must resume after cutover.
- Clients (`clients/hook`, `clients/uploader`, `apps/web`) import only `@learner/contract` (plus `@learner/functions-sdk` for `apps/web`).
- Pikku inspector traps (from biztools): a function defined beside its own wiring is silently skipped (wirings go in their own `*.wiring.ts`); new exports in an already-imported file stay invisible until the path changes; `.pikku-dev-state.json` is silently reused; a module `pikku all` imports must not read `.pikku` at module scope.
- Run the CLI as `bun node_modules/@pikku/cli/dist/bin/pikku.js` or `bunx --bun pikku`, never plain `bunx pikku` (wrong interpreter fakes PKU724).
- Never `tsc` with emit; typecheck is `bun run typecheck`.
- Secrets live in `/etc/learner/*.env`; never print them.
- Work in a fresh worktree. The dev API serves `/root/learner` with `bun --watch`, so editing it in place reloads the live service mid-change. Commit with pathspecs.

## Review Focus

1. **A desktop on the old pinned contract** posts to `/rpc/recordHabitEvents` after cutover: same status codes (400 schema, 401 bad key, 403 scope, 413 too large) and same `{message}` body, so its outbox rules still hold. Test: Task 5.
2. **A device key calling an admin RPC** gets 403, never 200, including when the call is nested inside an `app`-scoped function. Test: Task 4.
3. **`kill -9` during a workflow step** under the new entry resumes the run once, and a completed step does not run again. Test: Task 8.
4. **A run started by the old runtime** before cutover resumes under the new one, and is not adopted twice. Test: Task 8.
5. **Schedules firing in both processes** when api and worker run together: each schedule fires once per tick. Test: Task 7.

---

### Task 1: Spike — durable queues and workflows under the template entry (go/no-go)

**Files:**
- Create: `scratch/pikku-durable-spike/` (throwaway, never committed): a copy of the starter template with `db.engine: "postgres"`, one queue, one schedule and one two-step workflow.

**Interfaces:**
- Produces: a one-page finding in `MIGRATION-LOG.md` under "Starter layout spike", stating which of three options works:
  (a) `services.ts` replaces `queueService`, `workflowService`, `workflowRunService` and `schedulerService` with Learner's pg-boss and Kysely-durable implementations, under both `pikku dev` and the `-p standalone --runtime bun` artifact;
  (b) (a) works only for the standalone artifact; the dev box then runs the artifact (rebuilt on change) instead of `pikku dev`;
  (c) neither; stop the plan and report.

- [ ] **Step 1:** Port `packages/runtime-pikku/src/transport.ts` (pg-boss queue + table-renaming Kysely workflow service) into the spike's `services.ts`, replacing the injected in-memory services.
- [ ] **Step 2:** Run `bunx --bun pikku dev` against `learner_test`. Enqueue a job with the worker stopped; start it. Expected: the job drains from `learner_pikku_boss`, not memory.
- [ ] **Step 3:** Start the workflow, `kill -9` the process after step 1 completes, restart. Expected: step 2 runs, step 1 does not re-run, the run ends `completed`.
- [ ] **Step 4:** Repeat Steps 2-3 against `bunx --bun pikku deploy apply -p standalone --runtime bun` and its boot command.
- [ ] **Step 5:** Record the option that passed, with the exact commands, in `MIGRATION-LOG.md`; commit that file only. If (c), stop and report to the operator.

### Task 2: Upgrade Pikku in the current layout to the template's versions

**Files:**
- Modify: `package.json` (`overrides`: `@pikku/cli` 0.12.206, `@pikku/core` 0.12.152, `@pikku/kysely` 0.13.41, `@pikku/fetch` 0.12.14, `@pikku/deploy` 0.12.19, plus the remaining `@pikku/*` pins to their latest 0.12.x), `packages/runtime-pikku/package.json`, `bun.lock`, `patches/` (drop patches fixed upstream)
- Modify: `packages/runtime-pikku/src/**` only where the upgrade breaks it (0.12.197 renamed `onError` to `compensate` and the graph `actor` to `virtualUser`)
- Regenerate: `packages/runtime-pikku/src/generated/**`

- [ ] **Step 1:** Bump the pins; `bun install`.
- [ ] **Step 2:** `cd packages/runtime-pikku && bun run generate`. Expected: exits 0, "wiring up to date (… functions …)" with the same function count as before.
- [ ] **Step 3:** `bun run typecheck && bun run test`. Expected: both pass.
- [ ] **Step 4:** `LEARNER_PORT=3019 bun run gate`. Expected: every runtime passes.
- [ ] **Step 5:** Commit; push (the pre-push hook is the check).

### Task 3: Root config, `packages/functions` skeleton, `db/postgres`

**Files:**
- Create: `pikku.config.json` (root): `srcDirectories: ["packages/functions/src"]`, `outDir: "packages/functions/.pikku"`, `clientFiles` → `packages/functions-sdk/src/pikku/*` (same names as the template), `db: { engine: "postgres", pgliteExtensions: [] }`, `scaffold: { pikkuDir: "packages/functions/src/scaffold", rpc: true, workflow: true, console: true }`
- Create: `packages/functions/{package.json,src/application-types.d.ts,src/config.ts,src/services.ts,src/variables.ts}`, `packages/functions-sdk/package.json`
- Create: `packages/functions/src/functions/health.function.ts`, `packages/functions/src/health.wiring.ts`
- Move: `packages/server/src/db/migrations/00NN_*.sql` → `db/postgres/00NN-*.sql`
- Test: `packages/functions/test/health.test.ts`

**Interfaces:**
- Produces: `createConfig()` → `Config { port: number; host: string; postgresUrl: string; schedulesEnabled: boolean; webDist?: string }`; `createSingletonServices` exposing `kysely: Kysely<DB>`, `queueService`, `workflowService` per Task 1.

- [ ] **Step 1:** Write `health.test.ts`: boots the API on a free port against `learner_test`; asserts `GET /api/health` → 200 with `{ product: 'learner-server', contract: 1 }`, and 503 with an unreachable `postgresUrl`.
- [ ] **Step 2:** Run it. Expected: FAIL (no server).
- [ ] **Step 3:** Implement the skeleton and the health function + wiring.
- [ ] **Step 4:** `pikku db baseline` against `learner_test` and `learner` so the Pikku ledger records the 17 applied migrations; then `pikku db check`. Expected: no pending migrations, no drift.
- [ ] **Step 5:** `pikku all && pikku validate && bun test packages/functions/test/health.test.ts`. Expected: all pass.
- [ ] **Step 6:** Commit.

### Task 4: Auth, session middleware, scopes

**Files:**
- Create: `packages/functions/src/auth.ts` (`pikkuBetterAuth`, Postgres, apiKey plugin, `x-api-key`, Google provider when `LEARNER_GOOGLE_CLIENT_ID` is set), `packages/functions/src/middleware/session.middleware.ts`, `packages/functions/src/middleware/require-api-key.middleware.ts`
- Test: `packages/functions/test/auth.test.ts`

**Interfaces:**
- Consumes: `sessionForUser(kysely, authConfig, userId)` from the current `packages/server/src/auth.ts` (move it to `packages/functions/src/lib/session.ts`).
- Produces: `UserSession { userId: string; scopes: ('admin' | 'app')[]; email: string }`; scope requirements expressed as Pikku permissions so `pikkuFunc({ permissions: { admin } })` replaces `scopes: ['admin']`.

- [ ] **Step 1:** Write `auth.test.ts` with these cases: no credential on a machine route → 401; device (`app`) key on an admin RPC → 403; device key on `recordHabitEvents` → 200; admin session on an admin RPC → 200; an `app` function that calls an admin function over `rpc` → 403 (nested calls keep the caller's session).
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement auth + middleware + permissions; port the 3 functions the test needs ahead of Task 6.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit.

### Task 5: Wire-compatible `/rpc/:name` route

**Files:**
- Create: `packages/functions/src/functions/rpc-dispatch.function.ts`, `packages/functions/src/rpc.wiring.ts`
- Test: `packages/functions/test/rpc-wire.test.ts`

**Interfaces:**
- Produces: `POST /rpc/:name` that unwraps `{data}`, calls the function by name through Pikku's `rpc`, and maps errors to `{message}` with status 400 (schema), 401, 403, 404 (unknown name), 413, 500 (opaque).

- [ ] **Step 1:** Write `rpc-wire.test.ts`: for each status above, assert status code and that the body is exactly `{ message: string }`; assert a valid `recordHabitEvents` batch returns `{ accepted, duplicates }`; run every request shape from `packages/contract/contract.json` through it.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement the route.
- [ ] **Step 4:** Run it, plus the existing `contract-coverage.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit.

### Task 6: Move and convert the 300 definitions

**Files:**
- Create (temporary, deleted in Task 10): `scripts/codemod-pikku-native.ts`
- Move: `packages/server/src/functions/**` → `packages/functions/src/functions/**` (same subfolders, same file names)
- Test: `packages/functions/test/registry-parity.test.ts`

**Interfaces:**
- Consumes: the list of names from today's `packages/server/src/functions/registry.gen.ts`, saved to `packages/functions/test/fixtures/registry-before.json` before the move.
- Produces: one `pikkuFunc` / `pikkuSessionlessFunc` / `pikkuVoidFunc` / `pikkuWorkflowFunc` per old definition, same export name; inline Zod schemas exported as consts (PKU489); `scopes: [...]` mapped to Task 4's permissions; the third argument's `workflowStep.stepName` mapped to Pikku's `invocationId`, and `http.request.params()` to Pikku's request API.

- [ ] **Step 1:** Save `registry-before.json` (name, kind, expose, scopes for all 300).
- [ ] **Step 2:** Write `registry-parity.test.ts`: reads `packages/functions/.pikku` metadata after `pikku all` and asserts the same 300 names, kinds, `expose` flags and permissions as `registry-before.json`.
- [ ] **Step 3:** Run it. Expected: FAIL.
- [ ] **Step 4:** Write and run the codemod; fix by hand what it cannot convert.
- [ ] **Step 5:** `pikku all && bun run typecheck && bun test packages/functions/test`. Expected: all pass, including parity.
- [ ] **Step 6:** Commit.

### Task 7: Routes, queues and schedules as wirings

**Files:**
- Create: `packages/functions/src/wirings/http.wiring.ts` (17 routes from `packages/server/src/http/routes.ts`), `queues.wiring.ts` (14 queues from `packages/server/src/wiring/queues.ts`), `schedules.wiring.ts` (10 schedules)
- Test: `packages/functions/test/wirings.test.ts`

- [ ] **Step 1:** Write `wirings.test.ts`: the generated metadata has the same 17 routes (method + path + auth), 14 queues (name, batch size, concurrency) and 10 schedules (name, cron) as the old tables; with `LEARNER_SCHEDULES_ENABLED` unset no schedule is registered; with api and worker both running, a 1-minute test schedule fires once per tick.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Write the wirings, each in its own file (never beside a function).
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit.

### Task 8: Durable workflows and recovery

**Files:**
- Move: `packages/runtime-pikku/src/{recovery.ts,transport.ts,workflow-timer.ts}` → `packages/functions/src/lib/workflow/`; wire them in `services.ts` per Task 1
- Move: `packages/runtime-standalone/src/workflow/durable-crash.test.ts` → `packages/functions/test/durable-crash.test.ts`, rewritten against the new entry
- Test: also `packages/functions/test/cutover-resume.test.ts`

- [ ] **Step 1:** Rewrite `durable-crash.test.ts`: start the fixture workflow, SIGKILL the worker after step 1, restart; assert step 1 ran once, step 2 ran once, status `completed`.
- [ ] **Step 2:** Write `cutover-resume.test.ts`: insert a `running` run with a graph hash written by the current runtime-pikku, boot the new worker; assert it resumes once and no second worker adopts it.
- [ ] **Step 3:** Run both. Expected: FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run both. Expected: PASS.
- [ ] **Step 6:** Commit.

### Task 9: Dev loop, gate, CI, separation test

**Files:**
- Create: `scripts/dev.mjs` (template's, adapted: env from `/etc/learner/*.env`, no generated secrets, runs the Task 1 dev command plus `apps/web`)
- Modify: `scripts/gate.ts` (one runtime; boots the Task 1 entry), `tests/separation.test.ts` (keep "clients import only the contract"; delete the framework-confinement block), `.github/workflows/ci.yml` (add `pikku all`, `pikku validate`, standalone build + boot smoke), `package.json` scripts (`dev`, `start`, `worker`, `gate`)

- [ ] **Step 1:** `LEARNER_PORT=3019 bun run gate`. Expected: API, upload, uploader, queue, hook round trip, kill -9/resume and pairing (both topologies) pass on the new layout.
- [ ] **Step 2:** `bun run typecheck && bun run test`. Expected: pass.
- [ ] **Step 3:** Commit; push.

### Task 10: Delete the old runtimes and cut over the dev box

**Files:**
- Delete: `packages/runtime-standalone`, `packages/runtime-pikku`, `packages/server` (after confirming nothing imports it), `scripts/runtime.ts`, `scripts/gen-registry.ts`, `tests/runtime-select.test.ts`, `scripts/codemod-pikku-native.ts`
- Modify: `deploy/systemd/learner-{api,worker}.service` (`ExecStart` per Task 1), `README.md`, `CLAUDE.md`, `AGENTS.md`, `deploy/README.md`, `MIGRATION-LOG.md` (Decision 1 reversal, why)

- [ ] **Step 1:** Touch `/run/learner/learning-admission-paused`; wait until no run is `running`; record counts of `learner_workflow_runs` by status.
- [ ] **Step 2:** Delete the old packages; `bun install && pikku all && bun run typecheck && bun run test && LEARNER_PORT=3019 bun run gate`. Expected: all pass.
- [ ] **Step 3:** Install the new units, `systemctl daemon-reload && systemctl restart learner-api learner-worker`; then `curl -s https://dev.biztoolz.app/learner-api/api/health` and the `getLearningFeedbackCatalog` smoke from `deploy/README.md`. Expected: 200 and a catalog.
- [ ] **Step 4:** Remove the pause file; confirm a hook turn lands (hook health page) and the run counts from Step 1 only grew.
- [ ] **Step 5:** Commit; push.

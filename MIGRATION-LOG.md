# Migration log

Learner was extracted from the Learning app inside the previous host's
monorepo. Source files and their hashes are in `MIGRATION-SOURCE.md`; this file
records what was ported, what changed shape on the way, and what was left
behind on purpose. Nothing was stubbed: every function in the registry is the
ported implementation, and everything not ported is listed below.

## Ported

| Area | Where it lives now | Notes |
|---|---|---|
| Learning domain code (lib, services, seeds, curricula) | `packages/core` | Import paths rewritten; behaviour unchanged. |
| LLM layer (providers, CLI harness, model catalog, Langfuse transport) | `packages/llm` | Langfuse credentials now come from `LEARNER_LANGFUSE_ENV_FILE` (default `/etc/learner/langfuse.env`). |
| 281 server functions (97 session, 143 sessionless, 10 void, 31 workflows) | `packages/server/src/functions` | Same RPC names (the export name), same input/output schemas, same scopes. 96 are exposed over `/rpc`. |
| Function framework (define, validation, scopes, sessions, RPC invoke) | `packages/server/src/runtime` | In-repo replacement: `defineFunction` / `defineSessionlessFunction` / `defineVoidFunction` / `defineWorkflow`; `buildRegistry` refuses duplicate names. |
| Durable workflows | `packages/runtime-standalone/src/workflow/durable.ts` | Steps checkpointed in `learner_workflow_steps`, runs leased with a heartbeat; a killed executor's run is adopted once its lease lapses. Proven by `durable-crash.test.ts` (SIGKILL mid-run). |
| Queues (14) and schedules (10) | `packages/server/src/wiring/queues.ts` | Same names, handlers and worker settings. Schedules only run with `LEARNER_SCHEDULES_ENABLED=true`. |
| REST routes (17) | `packages/server/src/http/routes.ts` | `/api/learning/*`, playground, `/api/learning/hooks/:provider` (unauthenticated, as before), hindsight bridge (machine key required). |
| Auth | `packages/server/src/auth.ts` | Better Auth + API-key plugin, same `x-api-key` header. Admin scope comes from `LEARNER_ADMIN_EMAILS`, never from the key. |
| Native CLI hook | `clients/hook` | Same toggles, catalog parts, deferral/resume, trace outbox and health reports. |
| Learner web pages (Home, Progress, Live Feedback) | `apps/web` | Tailwind on the same glass tokens; Osmosis now shows live hook health, index status and the catalog. |
| Hindsight Python scripts | `scripts/hindsight` | Still run with the external `/opt/biztools-hindsight` venv (an install path outside this repo). |
| Data: 71 Learning tables + `telemetry_outbox`, Learning workflow runs | `learner` database | See "Data copy" below. |

## Changed shape

- **Client contract.** `packages/contract` holds the wire schemas for the ten
  RPCs the hook and the web app call, plus the pure modules both sides share
  (context delivery, hook context, hook health, live hook packet, teaching
  policy, index status). Core re-exports them, so server code is unchanged.
  `tests/separation.test.ts` fails if either client reaches past the contract.
- **The hook no longer compiles in the concept catalog.** It caches the
  catalog the server sends (begin packet or `--catalog`) at
  `<traceDir>/catalog.json`; the catalog companions read that cache. Deferral
  during an outage needs a cached catalog; without one the hook fails open.
- **Hook paths are configurable** (`LEARNER_URL`, `LEARNER_HOOK_KEY_FILE`,
  `LEARNER_HOOK_CONFIG`, `LEARNER_HOOK_TRACE_DIR`). The default trace
  directory is new (`/root/.claude/learner-hook-traces`), so the new hook never
  shares `.off` markers or pending traces with the running one. Cutover must
  carry the `.off` markers across.
- **Curriculum generation** reads pages through `FirecrawlMarkdownReader`
  (`FIRECRAWL_API_URL`) instead of the host's crawler provider service.
- **Audit events** are structured log lines (`event: 'audit'`) instead of the
  host's audit table writer.
- **Provenance source hashes** in experiment manifests now name this repo's
  paths, so a manifest hashed here differs from one hashed on the old host.
- **Runtime role** comes from `LEARNER_RUNTIME_ROLE`; the role fence is a
  Postgres advisory lock. The admission pause file is
  `/run/learner/learning-admission-paused` (`LEARNING_PAUSE_FILE` overrides).
- **Workflow wires.** The previous host stored a run's owner under a
  framework-prefixed key. Copied runs were rewritten once after the copy so
  every wire names its owner `userId` (a one-off `UPDATE` on
  `learner_workflow_runs`, counted below); the engine has no read-side
  fallback.
- **Workflow runs copied from the previous host are never adopted.** The
  engine only re-dispatches runs it leased itself, so the one Learning run
  that was `running` in the source snapshot stays as copied.
- **Test runs** use `TMPDIR=/tmp` (`bun run test`): three ported tests assume
  `tmpdir()` is not `/var/tmp`, which is this box's default. Tests that build
  an isolated schema from a historical migration read vendored copies in
  `packages/core/test/fixtures/source-migrations`.
- **Env names:** the host's environment variable became `LEARNER_ENV`. The
  Learning MVP gate (`LEARNING_LOCAL_MVP_ENABLED`) is kept and set in
  `/etc/learner/learner.env`.

## Carried source commits

Commits that landed in the source after the snapshot are carried as their net
diff. The hashes are in `MIGRATION-SOURCE.md` under "Carried source commits".

- **46ee018d** (net diff `4e07317b~1..46ee018d`), carried 2026-10-21:
  - `LEARNING_ASSESSMENT_PRIOR_MODE=cold|warm` (default cold), frozen per run as `VectorTurnConfig.priorMode`.
  - The cold pass grades every matching turn in four parts, with no prior for part 0.
  - The validator stamps `nodeVersion` by conceptId, and the model schema no longer asks for it.
  - A canonical key-sorted concept version (`conceptVersion`), with `nodeVersionMatches` accepting both legacy hashes.
  - The new admin RPC `readmitLearningReactiveTargets`.
  - New tests: `learning-cold-pass.test.ts`, plus `learning-concept-version.test.ts`, which does a real JSONB round trip on `learner_test`.
  - These are shared definitions, so both runtimes carry the change.

## Two runtimes

The operator's Amendment 2 (2026-10-21) has the shared definitions run under
two runtime packages. The framework one is the default, and
`LEARNER_RUNTIME=standalone` selects the other. `scripts/runtime.ts` makes the
choice; it never names the framework, and it falls back to standalone when the
adapter directory is absent.

- **`packages/runtime-pikku`.** Every wrapper and wiring file is GENERATED by
  `scripts/gen-wiring.ts` from the shared registry and from the
  route/queue/schedule tables. That covers one function wrapper per RPC name,
  plus wireHTTP, wireQueueWorker and wireScheduler. Workflow bodies are copied
  verbatim as `pikkuWorkflowFunc` files, so their DSL step names stay literal.
  There is no runtime registration. `scripts/generate.ts` runs the generator
  and then `pikku all`, and it fails on any CLI diagnostic.
- **Same rules under both runtimes.** Access checks and input parsing come from
  `packages/server/src/runtime/invoke.ts` in both. Privilege is always
  re-derived from the owning user (`sessionForUser`), never taken from the
  framework's own session mapping. Nested calls are internal (async context in
  `adapt.ts`), because the framework copies the caller's HTTP wire into every
  nested call. `/rpc/:name` keeps the `{data}` body.
- **Durable state shares one pair of tables.** Both runtimes write
  `learner_workflow_runs` / `learner_workflow_steps`. The framework's tables
  are renamed onto these by a Kysely plugin, and migration 0004 adds the
  framework's columns. pg-boss schemas are separate: `learner_boss` for
  standalone, `learner_pikku_boss` for the framework.
- **In-flight runs do not migrate between runtimes.** The standalone engine
  recovers only the runs it leased. The framework worker's boot recovery
  (`src/recovery.ts`) touches only runs carrying the graph hash that this
  runtime records at start, and only when every write predates the worker's
  boot. The framework's own stalled-run query treats a `running` step as
  proof of life, which is why its own recovery is not enough after a
  `kill -9`.
- **Observable differences.**
  - The hindsight bridge without a key answers 403 under the framework and
    401 under standalone.
  - Error bodies under the framework also carry `name` and `errorId`; the
    message text is the same.

### Incident: first framework worker boot (2026-10-21)

The first boot of the framework worker ran with an earlier recovery that had
no graph-hash guard. It resumed run `8b6ed5ff`, a copied
`learningIncrementalGradingWorkflow` run that was still `running`:

- It enqueued about 100 grading jobs, and about two model calls started.
- I killed the worker with `kill -9` within seconds, and no model processes
  were left behind.

Cleanup:

- Deleted the one step-history row it wrote (`2bed3b17`).
- Dropped the `learner_pikku_boss` schema, which held 101 jobs.

Step `baba6977` of that run keeps `updated_at = 2026-10-22 00:15:21`. The
previous value is unknown, because the copy does not record it.

Nothing in the source database was touched. The fix is the graph-hash guard
described above.

## Left behind, and why

| What | Why |
|---|---|
| The host's generated-graph test for the native Hindsight pilot | Tested the old framework's code generator output, which no longer exists. The pilot workflow itself is ported. |
| `learning-worker-runtime.test.ts` | Tested the old process-role plumbing that was rewritten (`learning-worker-runtime.ts`). Role behaviour is covered by the worker smoke. |
| The typesafe credential wire | A framework credential-injection hook. The typed-decision provider reads `LEARNER_TYPESAFE_ENV_FILE` (default `/etc/learner/typesafe.env`) directly. That file does not exist yet, so typed-decision arms report "provider not configured" until it does. |
| Steps of terminal (completed/failed/cancelled) Learning workflow runs | Runs are copied with output and error; their step rows are history only, and the engine never replays a terminal run. Steps of non-terminal runs are copied. |
| Non-Learning workflow runs | Not Learning data. |
| Learning admin page (`Learning/index.tsx`, curriculum builder, conversation history, playground, Sigma graph, vector experiment, concept assessment panel; ~3,500 lines) | Out of time for this extraction. The RPCs behind them are ported and exposed; only the UI is missing. Next port target. |
| Storybook stories for the Learner pages | No Storybook in this repo; the Playwright smoke covers rendering. |
| Users other than the operator; sessions and accounts | Only the operator's `user` row (and any user a Learning row references) is copied. Sessions are not: sign in again. API keys are minted fresh (`packages/server/scripts/mint-api-key.ts`). |

## Data copy

`scripts/copy-learning-data.ts` copies inside one exported repeatable-read
snapshot of the source database (read-only), so the source counts describe
exactly the rows copied. Per-table results are recorded below.

Copy run: 2026-10-21 22:56–23:35 UTC (the first attempt loaded every table,
then failed on the workflow-run query and lost its snapshot; it was re-run
from scratch with `--reset`). Verified with `scripts/verify-copy.ts`:

Source snapshot 0000005F-00AD2CB7-1: 72 tables, 52,061,249 rows, 0 mismatches

| table | source | learner | match |
|---|---:|---:|---|
| learning_active_archive_notifications | 5612 | 5612 | yes |
| learning_active_archive_sessions | 5 | 5 | yes |
| learning_archive_blobs | 119689 | 119689 | yes |
| learning_archive_checkpoints | 150497 | 150497 | yes |
| learning_archive_errors | 382921 | 382921 | yes |
| learning_archive_runs | 67653 | 67653 | yes |
| learning_archive_sources | 135377 | 135377 | yes |
| learning_archive_version_chunks | 5255152 | 5255152 | yes |
| learning_archive_versions | 82272 | 82272 | yes |
| learning_cli_vector_e2e_runs | 3 | 3 | yes |
| learning_concept_assessment_active | 1 | 1 | yes |
| learning_concept_assessment_attempts | 7248 | 7248 | yes |
| learning_concept_assessment_cache | 759 | 759 | yes |
| learning_concept_assessment_receipts | 12769 | 12769 | yes |
| learning_concept_assessment_runs | 12802 | 12802 | yes |
| learning_concept_edges | 2794 | 2794 | yes |
| learning_concept_tag_budgets | 3 | 3 | yes |
| learning_concept_tag_experiments | 16 | 16 | yes |
| learning_concept_tag_items | 937 | 937 | yes |
| learning_concept_tag_reservations | 63 | 63 | yes |
| learning_concepts | 1585 | 1585 | yes |
| learning_consolidator_prompt_experiments | 17 | 17 | yes |
| learning_consolidator_prompt_exports | 1447 | 1447 | yes |
| learning_curricula | 3 | 3 | yes |
| learning_curriculum_generation_runs | 2 | 2 | yes |
| learning_curriculum_lanes | 34 | 34 | yes |
| learning_curriculum_module_concepts | 1595 | 1595 | yes |
| learning_curriculum_module_dependencies | 254 | 254 | yes |
| learning_curriculum_modules | 183 | 183 | yes |
| learning_curriculum_sources | 6 | 6 | yes |
| learning_episode_artifacts | 0 | 0 | yes |
| learning_exposure_imports | 16515 | 16515 | yes |
| learning_exposure_observations | 397747 | 397747 | yes |
| learning_exposure_projection_cursors | 5953 | 5953 | yes |
| learning_exposure_work | 5951 | 5951 | yes |
| learning_extraction_benchmark_cases | 2471 | 2471 | yes |
| learning_extraction_benchmark_results | 2103 | 2103 | yes |
| learning_extraction_benchmark_runs | 63 | 63 | yes |
| learning_extraction_human_reviews | 0 | 0 | yes |
| learning_extractor_config | 1 | 1 | yes |
| learning_feedback_traces | 645 | 645 | yes |
| learning_hindsight_agy_bridge_requests | 0 | 0 | yes |
| learning_hindsight_consolidation_triggers | 0 | 0 | yes |
| learning_hook_events | 1260 | 1260 | yes |
| learning_hook_health_events | 13 | 13 | yes |
| learning_index_admission | 1 | 1 | yes |
| learning_index_notifications | 387610 | 387610 | yes |
| learning_live_feedback_turns | 702 | 702 | yes |
| learning_outcome_steering_dimensions | 0 | 0 | yes |
| learning_outcome_steering_evaluations | 0 | 0 | yes |
| learning_outcome_steering_evidence | 0 | 0 | yes |
| learning_playground_response_attempts | 2 | 2 | yes |
| learning_playground_response_receipts | 2 | 2 | yes |
| learning_reactive_admission | 1467 | 1467 | yes |
| learning_reactive_admission_settled_20261021 | 192 | 192 | yes |
| learning_reactive_embeddings | 8 | 8 | yes |
| learning_reactive_notifications | 38844 | 38844 | yes |
| learning_reactive_routes | 7309 | 7309 | yes |
| learning_reactive_settings | 1 | 1 | yes |
| learning_reactive_targets | 1273 | 1273 | yes |
| learning_semantic_index_chunks | 14206 | 14206 | yes |
| learning_semantic_index_members | 44539650 | 44539650 | yes |
| learning_semantic_index_messages | 17638 | 17638 | yes |
| learning_semantic_index_operations | 2836 | 2836 | yes |
| learning_semantic_index_runs | 3401 | 3401 | yes |
| learning_transcript_archive_checkpoints | 375 | 375 | yes |
| learning_turn_context_decisions | 5 | 5 | yes |
| learning_vector_arrivals | 12579 | 12579 | yes |
| learning_vector_turn_assessments | 8034 | 8034 | yes |
| learning_vector_turn_experiments | 7174 | 7174 | yes |
| telemetry_outbox | 20875 | 20875 | yes |
| @workflow_runs(learning*) | 322644 | 322644 | yes |

After the copy:

- 9,868 copied workflow wires had their owner key renamed to `userId`; 0 remain.
- `user` rows copied: the operator and `ada@scenarios.biztoolz.app` (a
  scenario fixture user that Learning rows reference). `canonical-index` is a
  pseudo-owner used by the semantic index, not a user.
- `@workflow_runs(learning*)` counts Learning runs; steps were copied only for
  the one non-terminal run.

## Open problems

- **Concept assessment needs a Hindsight grant (operator).** Starting one
  reads evidence from the `hindsight` database's read-only integration view.
  The `learner` role has no SELECT on it, and
  `LEARNING_VECTOR_TURNS_READ_VIEW_ENABLED` / `LEARNER_HINDSIGHT_DATABASE_URL`
  are unset. Granting it writes to the `hindsight` database, which this
  extraction was not allowed to touch. Until then `startLearningConceptAssessment`
  fails with "Native read-only integration view is not enabled". The worker
  crash/resume smoke used `learningWorkerProbeWorkflow` instead.
- **Typed-decision arms** need `/etc/learner/typesafe.env`.
- **Langfuse export** needs `/etc/learner/langfuse.env`.
- **Opt-in integration suites** gated by their own `*_TEST_DATABASE_URL`
  variables still expect purpose-built databases: the exposure suites
  `TRUNCATE` a table that the full schema references by foreign key, so
  they fail against `learner_test`. With those variables unset (the default)
  they skip, as on the previous host.
- **Sign-in for people** needs `LEARNER_GOOGLE_CLIENT_ID/SECRET` and the
  Learner origin registered as a Google OAuth redirect. Until then the web
  app works only with a machine key header (the smoke uses one).

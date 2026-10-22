# Learner

The Learning app on its own: a Bun workspace with no dependency on the host it
was extracted from. `MIGRATION-LOG.md` says what came over and what did not.

## Layout

| Path | What |
|---|---|
| `packages/contract` | Wire contract for the clients: RPC schemas, typed fetch client, shared pure hook modules. Imports only `zod`. |
| `packages/core` | Learning domain code: services, lib, seeds, generated DB types. |
| `packages/llm` | LLM providers, CLI harness, Langfuse transport. |
| `packages/server` | Shared definitions: functions, workflows, the route/queue/schedule tables, migrations. No host code. |
| `packages/runtime-standalone` | Runtime without the framework: Hono API, pg-boss worker, own durable workflow engine. |
| `packages/runtime-pikku` | Runtime on the Pikku framework (the default). Wirings are GENERATED from the shared tables by `scripts/gen-wiring.ts`; never hand-register a function there. |
| `apps/web` | Vite + React + Tailwind Learner UI. |
| `clients/hook` | Claude/Codex native hook (`src/index.ts`). |

The hook and the web app import **only** `@learner/contract` (enforced by
`tests/separation.test.ts`). A new RPC a client needs goes into
`packages/contract/src/rpc.ts`; `contract-coverage.test.ts` checks it exists on
the server.

## Commands

```bash
bun run typecheck                      # tsc --noEmit over the whole workspace
bun run test                           # bun test with /etc/learner/db.env (integration tests hit learner_test)
bun --env-file=/etc/learner/db.env packages/server/src/db/migrate.ts [--test]
bun scripts/gen-registry.ts            # after adding/removing a *.function.ts or *.workflow.ts
bun run build:web
bun run contract:json                  # regenerate packages/contract/contract.json

# run (port 3010); LEARNER_RUNTIME=standalone|pikku, default pikku when installed
bun run start                          # API  (scripts/runtime.ts api: runs the runtime's `prepare` codegen first)
bun run worker                         # worker
bun run gate [runtime...]              # api + queue + hook round trip + kill -9/resume, every runtime by default
bun --env-file=/etc/learner/db.env --env-file=/etc/learner/learner.env packages/runtime-standalone/src/worker.ts --once [--queue q] [--wait s]

# framework runtime codegen (also run by `prepare`; fails on any CLI diagnostic)
cd packages/runtime-pikku && bun run generate     # gen-wiring.ts + `bun ../../node_modules/@pikku/cli/dist/bin/pikku.js all` (never bunx)
```

## Rules

- Secrets live in `/etc/learner/*.env` (mode 600). Never print them; read key
  names with `sed 's/=.*//'`.
- Functions: the RPC name is the export name. `expose: true` puts it on
  `/rpc/<name>`; `scopes: ['admin']` requires an admin session.
- Workflow step bodies must be idempotent: a step that was running when its
  process died runs again on resume.
- Schedules are off unless `LEARNER_SCHEDULES_ENABLED=true`.
- The framework is confined to `packages/runtime-pikku`: no other package may
  import it, depend on it or even name it (`tests/separation.test.ts`), so the
  app installs, boots and tests with that directory deleted and
  `LEARNER_RUNTIME=standalone`. Shared code stays framework-neutral.
- In-flight workflow runs do not move between runtimes: each runtime recovers
  only the runs it started.

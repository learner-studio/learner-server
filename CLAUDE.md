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
| `clients/uploader` | `learner-upload`: tails a remote machine's Claude/Codex transcripts into `uploadTranscript` (device key). Durable + self-healing; see its README. |

The hook, the uploader and the web app import **only** `@learner/contract` (enforced by
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
LEARNER_PORT=3019 bun run gate [runtime...]  # api + upload + uploader + queue + hook + kill -9/resume + pairing (both configurations), every runtime; the dev API holds :3010, and the gate pauses learner-worker while it runs
bun --env-file=/etc/learner/db.env --env-file=/etc/learner/learner.env packages/runtime-standalone/src/worker.ts --once [--queue q] [--wait s]

# pairing with learner-desktop (docs/specs/server-desktop-pairing.md)
bun scripts/install.ts --out DIR [--api-url URL] [--growthbook ...] [--apply]   # render (and install) a new server's endpoint config
bun --env-file=/etc/learner/db.env --env-file=/etc/learner/learner.env scripts/pairing-server.ts --topology same-machine|remote [--port 3019] [--pairing-dir DIR] [--check]   # a real server on the TEST DB + throwaway pairing file

# framework runtime codegen (also run by `prepare`; fails on any CLI diagnostic)
cd packages/runtime-pikku && bun run generate     # gen-wiring.ts + `bun ../../node_modules/@pikku/cli/dist/bin/pikku.js all` (never bunx)
```

## Checks: hooks, CI, merge rule

Three tiers, each kept as small as it can be; `docs/checks.md` has the why.
Turn the hooks on once per clone: `bun run hooks:install`.

| Tier | Runs | Budget |
|---|---|---|
| pre-commit (`.githooks/pre-commit`) | only the tests co-located with staged files | seconds |
| pre-push (`.githooks/pre-push`) | `typecheck` + full suite, in parallel | < 1 min |
| CI (`.github/workflows/ci.yml`) | the same two, clean checkout, throwaway Postgres | required to merge |

`main` takes changes only through a PR with a green CI and the owner's
approval; repo admins bypass that, so direct pushes from the dev box still
work. `bun run gate` is in none of them (it needs `/etc/learner/*.env` and a
running stack): run it by hand before a release.

Agents push straight to `main` as the owner without asking: the pre-push hook
is the gate. Never `--no-verify`; a red hook means fix and push again. See
"Agents pushing as the owner" in `docs/checks.md`.

## Dev box: everything hot-reloads

On dev.biztoolz.app nothing is rebuilt or restarted by hand. `learner-web`
runs the Vite dev server (:5180, base `/learner/`) behind nginx, so UI edits
hot-update in the open browser. `learner-api` and `learner-worker` run
`bun --watch` (`runtime.ts dev` / `worker-dev`) and reload on any imported
file's CONTENT change across all workspace packages; a bare `touch` does not
count. A new `*.function.ts` / `*.workflow.ts` still needs
`bun scripts/gen-registry.ts` AND, for the default Pikku runtime,
`flock /run/learner/prepare.lock bun scripts/runtime.ts prepare` (its wiring
is generated; until then the new RPC answers 404). The watcher reloads code,
not the environment: a new key in `/etc/learner/*.env` needs
`systemctl restart learner-api learner-worker`. `build:web:proxied` / `dist-proxied` are not used on dev.

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

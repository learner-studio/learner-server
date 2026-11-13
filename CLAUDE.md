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
| `packages/runtime-pikku` | The runtime, on the Pikku framework (the only one). Wirings are GENERATED from the shared tables by `scripts/gen-wiring.ts`; never hand-register a function there. |
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

# run (port 3010)
bun run start                          # API  (scripts/runtime.ts api: runs the runtime's `prepare` codegen first)
bun run worker                         # worker
LEARNER_PORT=3019 bun run gate         # api + upload + uploader + queue + hook + kill -9/resume + pairing (both configurations); the dev API holds :3010, and the gate pauses learner-worker while it runs

# pairing with learner-desktop (docs/specs/server-desktop-pairing.md)
bun scripts/install.ts --out DIR [--api-url URL] [--growthbook ...] [--apply]   # render (and install) a new server's endpoint config
bun --env-file=/etc/learner/db.env --env-file=/etc/learner/learner.env packages/server/scripts/mint-api-key.ts --device ID --pairing-code   # PRINTS the one-paste code learner-pair-v1:… for the operator
bun --env-file=/etc/learner/db.env --env-file=/etc/learner/learner.env packages/server/scripts/mint-api-key.ts --ci-mint [--revoke]   # PRINTS a key that can only create/seed/revoke CI test devices (spec, round 2)
bun --env-file=/etc/learner/db.env --env-file=/etc/learner/learner.env scripts/pairing-server.ts --topology same-machine|remote [--port 3019] [--pairing-dir DIR] [--check]   # a real server on the TEST DB + throwaway pairing file

# framework runtime codegen (also run by `prepare`; fails on any CLI diagnostic)
cd packages/runtime-pikku && bun run generate     # gen-wiring.ts + `bun ../../node_modules/@pikku/cli/dist/bin/pikku.js all` (never bunx)
# pikku.config.json is at the repo root (the inspector must see packages/server/src); any other writing pikku
# command takes `-o packages/runtime-pikku/.pikku`, or it writes a stray /.pikku
bun ../../node_modules/.bin/pikku graph <functionId> --inspector go -o /var/tmp/<scratch>   # from packages/runtime-pikku
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
`runtime.ts dev` / `worker-dev`: a source change under `packages/` stops the
server (graceful), re-runs `prepare` (codegen), and starts it again (a new
migration is applied at the next restart, i.e. `bun run deploy`); a server that dies or fails to load exits the unit non-zero so systemd
restarts it. A new `*.function.ts` / `*.workflow.ts` still needs
`bun scripts/gen-registry.ts`. The watcher reloads code, not the environment:
a new key in `/etc/learner/*.env` needs a restart.

**Moving `/root/learner` to a new `main`: `bun run deploy`, never a bare
`git pull`.** It stops both units, pulls fast-forward, runs
`bun install --frozen-lockfile`, clears the git-ignored
`packages/runtime-pikku/.pikku`, starts both units (each runs prepare and
migrate before serving) and waits for API health and a fresh worker heartbeat;
non-zero means look at `/var/log/learner/{deploy,api,worker}.log`. From an
interactive session run it as `systemd-run --wait --collect --unit
learner-deploy --working-directory=/root/learner --setenv=HOME=/root bun scripts/deploy.ts`
(HOME: git's credential helper and bun's install cache live under it), so an ssh
hang-up cannot kill a pull mid-checkout. Starting a server
through `runtime.ts` applies pending migrations to its `DATABASE_URL`, so run
`bun run start|worker|gate` only from a `main` checkout against a shared DB.
`build:web:proxied` / `dist-proxied` are not used on dev.

## Rules

- Secrets live in `/etc/learner/*.env` (mode 600). Never print them; read key
  names with `sed 's/=.*//'`.
- Functions: the RPC name is the export name. `expose: true` puts it on
  `/rpc/<name>`; `scopes: ['admin']` requires an admin session.
- Workflow step bodies must be idempotent: a step that was running when its
  process died runs again on resume.
- Schedules are off unless `LEARNER_SCHEDULES_ENABLED=true`.
- Learner is Pikku-native (owner decision 2026-11-11, `MIGRATION-LOG.md`
  "Amendment 3"). Pikku is the runtime; shared code and docs may name and
  import it. Build with Pikku constructs (functions, workflows and steps,
  queues, schedules); it is the only runtime (the standalone engine was
  removed 2026-11-13). The hook, the uploader and the web app still import
  only `@learner/contract` (`tests/separation.test.ts`).
- The release ships the application plus the Pikku runtime basics, vendored
  in. It does NOT ship the test suite or development tools (the Pikku
  CLI/codegen, the Console, scenario and test tooling); Pikku's tests and
  checks are a development and CI gate. So: (1) generated wiring is produced
  at build time and shipped, because the code generator is not in the release
  (gap: `scripts/runtime.ts` still runs the `prepare` codegen at start);
  (2) runtime code never imports a dev-only `@pikku/*` package. The Console
  and the workflow graph are development-box diagnosis tools; health signals
  must work without them, in the app's own health surface.

## Restart-proof: a hard requirement (owner, 2026-11-11)

A restart of `learner-api` or `learner-worker` at ANY instant (SIGTERM,
SIGKILL, a `bun --watch` reload, a deploy, a reboot) must never lose work,
duplicate an effect, or leave anything waiting for a person. "Do not restart
the service" is never the fix; durability is. Full rule, the reviewer
checklist and the test pattern: `docs/operations/restart-safety.md`.

- **Where work lives.** Anything that outlives one request, or has an effect
  outside its own database transaction (an LLM call, a paid call, a
  notification, a file, another service), runs as a step of a Pikku durable
  workflow (or a Pikku queue job that starts one). No `setTimeout`/
  `setInterval` loops, in-memory queues, fire-and-forget promises or detached
  scripts hold work that matters. Pure reads and single-transaction writes
  are exempt.
- **Self-healing.** A step interrupted mid-flight is resumed or re-run by the
  runtime with no operator action: reservations carry a lease and heartbeat,
  orphans are reclaimed on boot and periodically, and a result that finished
  after its owner died is adopted, not discarded. A state that only a human
  can leave ("blocked, review receipts") is a defect unless the spec names
  the human decision it waits for.
- **Exactly-once effect.** Steps are idempotent (idempotency key or atomic
  claim), so a re-run publishes one reading, sends one notification.
- **Paid calls.** "Never repeat an unreceipted call" applies only to a
  backend declared metered and remote. A local child process (the Codex CLI)
  is repeatable: write its result to a durable per-attempt location and adopt
  or re-run.
- **Proof.** Every new or changed workflow, step, queue job or schedule ships
  a crash-recovery test that kills the process mid-step (SIGKILL and
  SIGTERM), restarts it, and asserts completion, one effect and no blocked
  row. A change without it is not done.
- **Review.** Every reviewer, human or agent, fills in the restart-safety
  checklist in `docs/operations/restart-safety.md` and reports CLEAN only if
  every row passes; "not applicable" needs the reason written down. Anyone
  briefing a reviewer includes that checklist in the brief.

## Least code, built from shared Pikku parts (owner, 2026-11-11)

The smallest total amount of code and tests that meets the requirement, with
the fewest functions, and workflows that build on and reuse each other the
Pikku way. Detail and the reviewer's reduction pass:
`docs/operations/restart-safety.md` ("Reduction pass").

- Before writing a function, step, workflow, queue or schedule, find the one
  that already does it and call it (a workflow starts a sub-workflow or
  invokes an existing function by RPC name; a step body is an existing
  function, not a copy). A second implementation of the same thing is a
  defect.
- One mechanism per concern, shared by every workflow: one reservation/lease/
  reclaim path, one idempotency helper, one LLM call step, one crash-test
  harness. A new workflow adds its own steps only.
- Tests: one test per behaviour, at the lowest tier that can fail for it.
  Delete a test that another test already makes redundant; share fixtures and
  harnesses, do not copy them.
- No compatibility shims, dead branches, unused exports or speculative
  options. Remove what a change makes unused, callers included.
- **Review.** Every reviewer runs the reduction pass and lists, with line
  counts, what can be deleted, merged or replaced by an existing Pikku
  construct. A review is CLEAN only when that list is empty; the author
  applies it and reports lines and functions before and after.

## GrowthBook

Agents may read and write GrowthBook. The API address, the admin key file and the
backup rule are in `docs/operations/growthbook.md`. Never treat a GrowthBook change
as blocked on an admin.

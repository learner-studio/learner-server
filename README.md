**WARNING THIS IS A VIBE-CODED PROTOTYPE**

# Learner (server)

Learner turns the work you already do with AI coding agents into a record of
what you understand. It captures your Claude Code and Codex sessions (plus
chats and meeting transcripts from the desktop app), grades the concepts you
demonstrate against a concept catalog, and feeds that back into your next
session through a native CLI hook. The hook prompts the agent to teach
through the task you are doing, starting from your weakest prerequisite.

This repository is the server, the web UI and the CLI clients. The macOS app
lives in [learner-studio/learner-desktop](https://github.com/learner-studio/learner-desktop).

> Status: a prototype run by one person on one dev box. Interfaces, the schema
> and the data model change without notice. There are no releases, no
> migration guarantees and no support. Read the code before you trust it with
> anything.

## How it fits together

```
 Claude Code / Codex ──hook──▶ /api/learning/hooks ─┐
 CLI transcripts ─────────────▶ archive sweep  ─────┤      ┌──────────────┐
   (this box: read from disk;                       ├─────▶│  Postgres     │
    other machines: learner-upload ▶ uploadTranscript)     │  + pg-boss    │
 learner-desktop ──device key──▶ /rpc (habits,      │      └──────┬───────┘
                                  calls, chats)  ───┘             │
                                                     grading, curricula,
 Read AI ──webhook──▶ /api/webhooks/readai/:token    semantic index, feedback
                                                                  │
                      web UI (/learner) ◀──── /rpc ◀──────────────┘
```

- **Capture.** On this machine the lossless archive sweeps `~/.claude/projects`,
  `~/.codex/sessions` and the other provider roots every minute. It stores
  every version of every file as deduplicated, content-addressed chunks. Other
  machines send theirs with `learner-upload`. Desktop chats, calls and habit
  events arrive over typed RPCs with a per-device key. Read AI meetings arrive
  through a webhook you set in **Settings → Integrations → Read AI webhook**.
- **Grade.** Each user turn is tagged with the concepts it shows. The tags
  carry exact quotes and are scored conservatively: asking a question or
  using a word is not evidence of understanding. A session copied between
  machines counts once, because grading keys are the providers' native ids.
- **Teach.** The CLI hook (`clients/hook`) injects a teaching policy and the
  learner's weakest relevant foundations into each turn. The agent then
  submits structured feedback, which updates mastery.
- **Look.** The web app (`apps/web`) shows the concept graph, progress,
  conversation history, curricula, hook health and settings.

## Layout

| Path | What |
|---|---|
| `packages/contract` | The wire contract: RPC schemas and the typed fetch client. The clients import only this. |
| `packages/core` | Domain code: archive, grading, curricula, semantic index, call pipeline. |
| `packages/llm` | LLM providers, CLI harness, Langfuse transport. |
| `packages/server` | Functions, workflows, the route/queue/schedule tables, migrations. Framework-neutral. |
| `packages/runtime-*` | Two runtimes for the same functions: the default one sits on a framework adapter whose wiring is generated; `runtime-standalone` uses none: Hono API, pg-boss worker, its own durable workflow engine. |
| `apps/web` | Vite + React + Tailwind UI. |
| `clients/hook` | The Claude Code / Codex native hook. |
| `clients/uploader` | `learner-upload`: captures a remote machine's CLI sessions ([README](clients/uploader/README.md)). |
| `docs/` | [checks](docs/checks.md), the [desktop API](docs/learner-desktop-api.md), specs. |

Both runtimes run the same functions, and `bun run gate` checks each one end
to end.

## Running it

You need Bun 1.4+, Postgres 17 and the env files in `/etc/learner/` (database
URLs, auth, providers; they are never committed).

```bash
bun install && bun run hooks:install
bun --env-file=/etc/learner/db.env packages/server/src/db/migrate.ts   # add --test for learner_test
bun run start        # API on :3010 (LEARNER_RUNTIME picks the runtime)
bun run worker       # queues, durable workflows, schedules (LEARNER_SCHEDULES_ENABLED=true)
bun run dev:web      # UI on Vite
```

### Pairing with learner-desktop

The server and the desktop app are installed as a pair, on one machine or two.
The server advertises every URL the desktop needs (API, web UI, GrowthBook,
whether to run the uploader) through `getPairingEndpoints`. Set them up with:

```bash
# same machine: the API stays on loopback; add --growthbook for a local GrowthBook on :3200/:3201
bun scripts/install.ts --out ./install-out [--growthbook] [--apply]
# remote: the public URL of the API; nginx gets deploy/nginx/learner-api.conf
bun scripts/install.ts --out ./install-out --api-url https://learner.example.org/learner-api [--apply]
# then one device key as a pairing file (mode 600) the desktop imports on first launch
bun --env-file=/etc/learner/db.env --env-file=/etc/learner/learner.env packages/server/scripts/mint-api-key.ts \
  --device my-mac --pairing ~/Library/Application\ Support/Learner/desktop-pairing.json --owner "$USER"
```

A remote install publishes no web UI or GrowthBook until you put them behind
your own login (`LEARNER_WEB_URL`, `LEARNER_GROWTHBOOK_URL`); the spec,
[docs/specs/server-desktop-pairing.md](docs/specs/server-desktop-pairing.md),
says why. A macOS package for the server itself (launchd, Homebrew Postgres)
does not exist yet.

To capture another machine's sessions, mint a device key on the server with
`packages/server/scripts/mint-api-key.ts --device <clientId>`. Then run
`clients/uploader` on that machine under launchd or systemd. See its README.

## Checks

| Tier | Runs |
|---|---|
| pre-commit | the tests next to the staged files |
| pre-push | `typecheck` + the full suite |
| CI | the same, on a clean checkout with a throwaway Postgres |
| `bun run gate` (by hand) | both runtimes against a real stack: API, upload, uploader CLI, queue, hook round trip, and a durable workflow that survives `kill -9` |

On a box that already runs the dev stack, use `LEARNER_PORT=<free port> bun run gate`.
The gate pauses the systemd `learner-worker` while it runs and restarts it afterwards.

Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).

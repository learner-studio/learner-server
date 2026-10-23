# learner-desktop ⇄ learner-server API

Status: **live** (2026-10-22). The tunnel route below is retired. Owners: learner-server (this repo) and
learner-desktop (`learner-studio/learner-desktop`, the macOS app). Each side's checklist is at the bottom. Tick items in the
repo that owns them, and reply in the learner-desktop tracking issue.

## Why (the retired route)

Until 2026-10-22 learner-desktop reached the server through an SSH tunnel and
wrote directly into the server's storage:

| Tunnel port | Server target | What the app does with it |
|---|---|---|
| `:15432` → Postgres `:5432` | `habits` DB, role `habits_writer` | `INSERT INTO habit_events … ON CONFLICT (event_id) DO NOTHING` from `sync-habits.ts`, which Swift spawns every 8 s, at shutdown and from `stop-capture.sh` to drain the local SQLite. One-off baseline import of `habit_events` and `call_transcripts` from `scripts/ingest_to_postgres.ts`. |
| `:18925` → Hindsight | bank `learning-transcript-archive-v1` | `POST /v1/default/banks/<bank>/memories` from `src/sync-service.ts` (ai-vault conversations) |
| `:3200` → GrowthBook | UI only | the "Open GrowthBook Dashboard" menu item |

That route caused several problems:
- The app depends on internal table, column, bank and port names, so any
  server-side change breaks it without warning.
- A database password lives on the Mac (in `.env`; `.env.example` holds only
  the placeholder `REPLACE_ME`).
- The server cannot validate input or apply rate limits, and it cannot tell
  that a client has gone quiet. `sync-habits.ts` also exits 0 when inserts
  fail, so its success logs can't be trusted.
- The Hindsight bank has received nothing since 2026-09-07. That isn't a sync
  failure: nothing new was exported. The `ai-vault backup` exporter has never
  been scheduled; it runs only through `sweep-ai-vault.sh` or the "Pull Latest
  Chats" menu item. The server, however, cannot tell "no exports" from "sync
  broken".

The goal is that the app talks to the server only over **HTTPS RPC with a
per-device API key**. The tunnel and the database credential then go away.

## Transport: HTTPS over TCP. Not UDP.

- Every payload is a record that must arrive **exactly once**: habit events,
  call transcripts and conversation documents. UDP drops, duplicates and
  reorders packets, so reliability, ordering and dedup would all have to be
  rebuilt on top of it. HTTPS plus idempotency keys already gives that.
- The latency-critical loop (speech → 30 s/60 s cue → Pavlok) runs **entirely
  on the Mac** and never crosses the network. What gets uploaded afterwards is
  a few KB per minute, so latency doesn't matter.
- The server exposes only TCP 80/443 through nginx (ufw allows UDP for mosh
  only). Corporate and hotel networks often block UDP.
- If a lower-latency transport is ever wanted, HTTP/3 (QUIC, which runs over
  UDP) can be enabled in nginx with no change to the API.

## Wire format (already in production for the CLI hook)

- `POST https://dev.biztoolz.app/learner-api/rpc/<name>`
- Headers: `content-type: application/json`, `x-api-key: <device key>`
- Body: `{ "data": <input> }`. The response is the output JSON. A non-2xx
  response has the body `{ "message": … }`.
- Health: `GET https://dev.biztoolz.app/learner-api/api/health` → 200
- The schema source of truth is `packages/contract/src/rpc.ts` in this repo.
  The generated JSON Schema is `packages/contract/contract.json`
  (`bun run contract:json`). learner-desktop pins a learner-server commit and
  checks its Swift `Codable` structs and TS types against that file in a test.
- Body limit: 20 MB at nginx. Keep each request under 4 MB; that is already
  the `uploadTranscript` cap.

## Auth

- Each Mac gets its own API key with a new, narrow scope **`app`**, minted on
  the server (Better Auth apiKey plugin). It is not an admin key. A lost
  laptop means revoking one key.
- The app stores the key in the **macOS Keychain**, not in `.env` or a plist.
- `clientId` (`^[a-z0-9][a-z0-9-]{0,62}$`, for example `ben-mbp`) names the
  device in every write.

## RPCs

All writes are **idempotent**. The client generates the id and the server
ignores a duplicate, so retrying after a timeout is always safe.

| RPC | Status | Input → Output |
|---|---|---|
| `recordHabitEvents` | **new** | `{ clientId, events: HabitEvent[1..500] }` → `{ accepted, duplicates }` |
| `recordCallTranscripts` | **new** | `{ clientId, calls: CallTranscript[1..50] }` → `{ accepted, updated }` (upsert on `sessionId`; the row adopts the sent `callId`). The device's `learner` flags are ignored: the server re-attributes every line with the same rules as `recordCalls`, and a meeting the Read.ai webhook already delivered is set aside, so the Mac app can keep uploading without double grading. |
| `recordCalls` | **new**, provider-neutral | `{ clientId, calls: ({ format: 'readai', payload } \| { format: 'speech', source, call: { sessionId, lines: [{ speaker, text, at, endAt? }], … } })[1..20] }` → `{ accepted, updated, unchanged, notGraded, duplicates }`. The client sends raw speech with no learner flag; the SERVER attributes the learner's lines (identity names/emails from `saveCallIdentity`, a person's per-call choice, or elimination; see `attributeSpeakers`), sets aside a meeting another source already delivered (`duplicates`), and runs the same store → spool → grading path as `recordCallTranscripts`. A new provider is one adapter in `packages/core/src/lib/learning/call-ingest.ts`. biztools forwards every Read.ai delivery here as device `biztools`. Prefer this over parsing on the device. |
| `archiveConversationDocuments` | **new**, replaces the direct Hindsight writes | `{ clientId, documents: { documentId, source, title?, occurredAt, contentSha256, text, metadata }[1..50] }` → `{ accepted, unchanged }`. The server owns the bank name and does the retaining. |
| `recordAppHeartbeat` | **new** | `{ clientId, appVersion, screenpipeVersion, captureState, outboxDepth, lastSentAt, lastVaultExportAt }` → `{ serverTime }`. Sent every 5 min, so silence becomes visible. |
| `uploadTranscript` | exists | Offset-addressed Claude/Codex `.jsonl` chunks, `≤ 4 MB` each. Use it only if the Mac's own agent transcripts should feed Learning. |

`HabitEvent` is the `habit_events` row in camelCase:

```
eventId (uuid, client-generated)  sessionId  callApp  callCategory
timestamp (ISO-8601, when spoken; audio clock where available)
habitType  treatmentArm  turnDurationSec  wordsSpoken
warningFiredAtSec?  shockFiredAtSec?  latencyToYieldSec?
breached30s (bool)  breached60s (bool)  wasRewarded (bool)
metadata (object; includes measurement, gap_duration_sec, coach settings,
          capture_phase, screenpipe_version, screenpipe_app_version)
```

- `warningFiredAtSec` / `shockFiredAtSec` are **not timestamps**. They are the
  streak length in seconds at which the cue fired (`number | null`), stored in
  the existing `warning_fired_at` / `shock_fired_at` columns.
- `timestamp` must be ISO-8601 with an offset (the client normalizes to UTC
  `Z`). Anything else is a `400`.
- `habitType`, `callCategory` and `treatmentArm` are free strings, not enums.
  Values seen so far: `monologue_streak`, `pavlok_intervention`,
  `monologue_duration`; `solo`, `work`, `client`, `demo`, `device_test`; arms
  include `manual_test`. Analysis filters these; the writer accepts them all.
- `metadata.capture_phase` equals the GrowthBook phase name (e.g.
  `screenpipe 2.7.116 / engine 0.4.52`).

The booleans become booleans on the wire. The server converts them to the
existing integer columns, so GrowthBook queries stay unchanged.

`CallTranscript` is the `call_transcripts` row in camelCase (`callId` uuid,
`eventTime`, `participants`, `benPresent`, `benSpoke`, `isDemo`, `cleanTranscript`, …).
`cleanTranscript` is stored verbatim and never parsed. Grading reads only
`utterances`: `[{ speaker, text, at, learner }]`, in spoken order. The device
attributes speakers, and `learner` is true only for the learner's own lines
(an unattributed speaker is false). The server merges consecutive lines by one
speaker. Each learner turn is graded with the lines spoken just before it, the
way a chat reply is graded with its prompt. A call with no learner line is
stored but not graded.

Error statuses the client must handle:
- `400`: a schema rejection. Do not retry. Log it and park the record.
- `401` or `403`: a bad or revoked key. Stop sending and show `🔑` in the tray.
- `413`: the batch is too large. Halve it and retry.
- `429` and `5xx`: retry with exponential backoff and jitter, from 2 s up to
  a 5 min cap.

## Client behaviour (learner-desktop)

- **Outbox, not a live connection.** Rows are already written to
  `~/.ai-aggregator/behavior_experiments.sqlite` first. Keep that and add a
  `sent_at` column. A sender drains unsent rows in batches every 30 s and on
  quit. The coaching loop never waits on the network.
- **Stay offline-tolerant.** The outbox can grow for days. Show its depth in
  the tray (`📤 n`), and report it in the heartbeat.
- **Native sender in Swift.** The SQLite file is already the outbox: Swift
  writes it, then `sync-habits.ts` drains it to Postgres. The Swift app takes
  over the upload directly (`URLSession`, key from the Keychain). It treats any
  non-2xx as a failure, which `sync-habits.ts` does not. `sync-habits.ts`, its
  `.env` and `HABITS_PG_URL`, and the bun dependency for sync are then
  deleted.
- **Baseline import.** `scripts/ingest_to_postgres.ts` becomes a one-off that
  calls `recordHabitEvents` / `recordCallTranscripts`.

## Server behaviour (learner-server)

- **Keep the `habits` DB where it is for now.** GrowthBook's datasource reads
  it. The server becomes its only writer through a server-owned role. Moving
  the tables into the `learner` DB can come later.
- New functions follow the existing pattern
  (`packages/server/src/functions/learning/*.function.ts`, `expose: true`,
  `scopes: ['app']`), are added to `packages/contract/src/rpc.ts`, and are
  followed by a run of `bun scripts/gen-registry.ts`.
- Add an alert when no heartbeat has arrived for 24 h while capture is
  expected to be on. Use `lastVaultExportAt` to report "no exports" separately
  from "sync broken".
- GrowthBook phases are currently started by `scripts/start-capture-phase.py`
  over ssh into the `growthbook-mongo` container. The server should own that
  eventually.

## Cutover (in order)

1. **Server:** add the `app` scope, the four RPCs and a contract test; mint a
   device key and deliver it out of band, not through chat or git.
2. **App:** store the key in the Keychain and add the HTTPS sender with its
   outbox. No overlap period: per Ben, the final client replaced the old
   route directly.
3. **App:** remove the Postgres and Hindsight forwards from `tunnel.sh`.
   Remove `HABITS_PG_URL` and `HINDSIGHT_URL` and delete `sync-habits.ts`.
   Update everything that probes the old ports: the tray "Hindsight" light
   (`:18925`), `stop-capture.sh` (which flushes through `sync-habits.ts`), and
   `docs/screenpipe-update-runbook.md` (`:15432`, `:3200`, `:18925`).
4. **Server (done 2026-10-22):** `pg_hba.conf` rejects `habits_writer` from
   127.0.0.1 and ::1, which is where the tunnel arrives. Its INSERT, UPDATE,
   DELETE and TRUNCATE grants are revoked. It survives only as GrowthBook's
   read-only datasource role, from the docker network. Its password is not
   rotated because it is unusable outside that network, and rotating it would
   mean re-keying GrowthBook's datasource. The server writes as
   `learner_habits` (`LEARNER_HABITS_DATABASE_URL`). Row-count reconciliation
   should expect ±5: 2 local-only test rows, and 3 server-only E2E demo
   fixtures.
5. **Both:** decide whether to keep the GrowthBook UI (`:3200`) behind the
   tunnel or give it an nginx host. That is the only port left to decide.

## Checklists

**learner-server**
- [x] `app` scope: device users `<clientId>@devices.learner.invalid`, minted by
      `packages/server/scripts/mint-api-key.ts --device <clientId>`, with the
      key file at `/etc/learner/device-<clientId>.key.env`
- [x] `recordHabitEvents`, `recordCallTranscripts`, `archiveConversationDocuments`
      and `recordAppHeartbeat`, plus the contract, the spool test and an
      end-to-end smoke run through nginx. Chats and the learner's call speech
      reach mastery scoring through the `desktop-uploads` archive root.
- [x] `getLearnerDesktopStatus` (admin): per-device health `ok`, `silent`,
      `no-exports` or `never-seen`
- [ ] an alert that pushes that health out (today it is only queryable)
- [x] retire the tunnel route: `habits_writer` is localhost-rejected and read-only

**learner-desktop**
- [x] Fix fresh clones (learner-desktop `b4b193f`: screenpipe's `filter=lfs`
      rules dropped; a fresh clone checks out all 4,200 files). Whether to
      keep vendoring screenpipe at all is still Ben's call.
- [ ] Keychain key + `clientId` setting
- [ ] Native Swift sender reading the SQLite outbox; backoff and error
      handling as specified above; tray states `📤 n` / `🔑`; heartbeat
      carries `lastVaultExportAt`
- [ ] A contract test of the Codable structs against the pinned `contract.json`
- [ ] Drop the Postgres and Hindsight forwards, `sync-habits.ts` and the DB
      env vars; update the tray light, `stop-capture.sh` and the runbook
- [ ] Decide whether to schedule the `ai-vault backup` export (Ben's call)

# learner-app ⇄ learner-server API

Status: **proposed** (2026-10-22). Owners: learner-server (this repo) and
learner-app (`learner-studio/learner-app`, the macOS app formerly called
learner-desktop). Each side's checklist is at the bottom. Tick items in the
repo that owns them, and reply in the learner-app tracking issue.

## Why

Today learner-app reaches the server through an SSH tunnel and writes directly
into the server's storage:

| Tunnel port | Server target | What the app does with it |
|---|---|---|
| `:15432` → Postgres `:5432` | `habits` DB, role `habits_writer` | `INSERT INTO habit_events … ON CONFLICT (event_id) DO NOTHING` (Swift `HabitLogger` + `src/sync-habits.ts`), `call_transcripts` (`scripts/ingest_to_postgres.ts`) |
| `:18925` → Hindsight | bank `learning-transcript-archive-v1` | `POST /v1/default/banks/<bank>/memories` from `src/sync-service.ts` (ai-vault conversations) |
| `:3200` → GrowthBook | UI only | the "Open GrowthBook Dashboard" menu item |

This causes several problems:
- The app depends on internal table, column, bank and port names, so any
  server-side change breaks it without warning.
- A database password lives on the Mac (and one sits in the history of
  `.env.example`).
- The server cannot validate input or apply rate limits, and it cannot tell
  that a client has gone quiet. The Hindsight bank has received nothing since
  2026-09-07, and no alert fired.

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
  (`bun run contract:json`). learner-app pins a learner-server commit and
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
| `recordCallTranscripts` | **new** | `{ clientId, calls: CallTranscript[1..50] }` → `{ accepted, updated }` (upsert on `callId`) |
| `archiveConversationDocuments` | **new**, replaces the direct Hindsight writes | `{ clientId, documents: { documentId, source, title?, occurredAt, contentSha256, text, metadata }[1..50] }` → `{ accepted, unchanged }`. The server owns the bank name and does the retaining. |
| `recordAppHeartbeat` | **new** | `{ clientId, appVersion, screenpipeVersion, captureState, outboxDepth, lastSentAt }` → `{ serverTime }`. Sent every 5 min, so silence becomes visible. |
| `uploadTranscript` | exists | Offset-addressed Claude/Codex `.jsonl` chunks, `≤ 4 MB` each. Use it only if the Mac's own agent transcripts should feed Learning. |

`HabitEvent` is the `habit_events` row in camelCase:

```
eventId (uuid, client-generated)  sessionId  callApp  callCategory
timestamp (ISO-8601, when spoken; audio clock where available)
habitType  treatmentArm  turnDurationSec  wordsSpoken
warningFiredAt?  shockFiredAt?  latencyToYieldSec?
breached30s (bool)  breached60s (bool)  wasRewarded (bool)
metadata (object; includes measurement, gap_duration_sec, coach settings, phase)
```

The booleans become booleans on the wire. The server converts them to the
existing integer columns, so GrowthBook queries stay unchanged.

`CallTranscript` is the `call_transcripts` row in camelCase (`callId` uuid,
`eventTime`, `participants`, `benPresent`, `benSpoke`, `isDemo`, `cleanTranscript`, …).

Error statuses the client must handle:
- `400`: a schema rejection. Do not retry. Log it and park the record.
- `401` or `403`: a bad or revoked key. Stop sending and show `🔑` in the tray.
- `413`: the batch is too large. Halve it and retry.
- `429` and `5xx`: retry with exponential backoff and jitter, from 2 s up to
  a 5 min cap.

## Client behaviour (learner-app)

- **Outbox, not a live connection.** Rows are already written to
  `~/.ai-aggregator/behavior_experiments.sqlite` first. Keep that and add a
  `sent_at` column. A sender drains unsent rows in batches every 30 s and on
  quit. The coaching loop never waits on the network.
- **Stay offline-tolerant.** The outbox can grow for days. Show its depth in
  the tray (`📤 n`), and report it in the heartbeat.
- **Only one writer.** Today both Swift `HabitLogger` and `src/sync-habits.ts`
  insert into `habit_events`. After the change exactly one sender owns the
  upload (the Swift app is the natural one; it already runs the watcher), and
  the other path is deleted.

## Server behaviour (learner-server)

- **Keep the `habits` DB where it is for now.** GrowthBook's datasource reads
  it. The server becomes its only writer through a server-owned role. Moving
  the tables into the `learner` DB can come later.
- New functions follow the existing pattern
  (`packages/server/src/functions/learning/*.function.ts`, `expose: true`,
  `scopes: ['app']`), are added to `packages/contract/src/rpc.ts`, and are
  followed by a run of `bun scripts/gen-registry.ts`.
- Add an alert when no heartbeat has arrived for 24 h while capture is
  expected to be on.

## Cutover (in order)

1. **Server:** add the `app` scope, the four RPCs and a contract test; mint a
   device key and deliver it out of band, not through chat or git.
2. **App:** store the key in the Keychain, add the HTTPS sender with its
   outbox, keep the tunnel for one overlap day, and confirm with the server
   that row counts match.
3. **App:** remove the Postgres and Hindsight forwards from `tunnel.sh`.
   Remove `HABITS_PG_URL` and `HINDSIGHT_URL`, delete `sync-habits.ts`'s
   direct SQL, and replace `.env.example` with placeholders.
4. **Server:** rotate the `habits_writer` password (the old value is in git
   history). Then revoke that role's network login entirely.
5. **Both:** decide whether to keep the GrowthBook UI (`:3200`) behind the
   tunnel or give it an nginx host. That is the only port left to decide.

## Checklists

**learner-server**
- [ ] `app` scope + device key minting (`bun scripts/…` that prints the key once, to the operator)
- [ ] `recordHabitEvents`, `recordCallTranscripts`, `archiveConversationDocuments`, `recordAppHeartbeat` + contract + tests against `learner_test` / a scratch `habits`
- [ ] heartbeat-silence alert
- [ ] rotate `habits_writer`, then drop its login

**learner-app**
- [ ] Re-upload the 56 missing Git LFS objects (`git lfs push --all origin`
      from the Mac), or better, stop vendoring all of screenpipe (4,138 files)
      and fetch a pinned version at build time.
- [ ] Keychain key + `clientId` setting
- [ ] Outbox sender (single writer), backoff and error handling as specified
      above, tray states `📤 n` / `🔑`
- [ ] A contract test of the Codable structs against the pinned `contract.json`
- [ ] Drop the Postgres and Hindsight forwards and the DB env vars, and put
      placeholders in `.env.example`
- [ ] Find out why the ai-vault → Hindsight sync stopped on 2026-09-07

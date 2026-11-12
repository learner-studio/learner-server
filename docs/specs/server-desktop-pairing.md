# Server–desktop pairing: who tells whom which URLs

Status: plan v2, 2026-10-28, after an adversarial review (12 findings; the
v1 draft's GrowthBook-subpath, topology-inference, discovery and dry-run
designs were wrong and are gone). Owner direction (Ben): learner-server and
learner-desktop are always installed together, on the same machine or on two;
GrowthBook runs and is hosted with learner-server, so its link is dynamic like
every other server URL.

## The two configurations

| | same-machine | remote (today: Mac → ovh) |
|---|---|---|
| API the desktop uses | `http://127.0.0.1:3010` | `https://<origin>/learner-api` |
| Web UI | `http://127.0.0.1:3010/` (the API serves the built web) | only when the operator publishes one behind its own human auth (`LEARNER_WEB_URL`); null otherwise |
| GrowthBook | `http://127.0.0.1:3200` (UI) + `:3201` (API), loopback-bound | only on its own origin behind a gate (`LEARNER_GROWTHBOOK_URL`); null otherwise |

Why remote web and GrowthBook are opt-in, not rendered: the Learner has no
human sign-in of its own (the dev box's `/learner/` rides biztools' gate,
`deploy/nginx/learner.conf`), and a fresh GrowthBook gives its owner account
to the first visitor. Publishing either for a stranger without a gate makes
it world-admin. GrowthBook also cannot live under a subpath without the
root-level aliases and header map this box uses; a stranger's install gets
its own origin or nothing. The dev box keeps its existing, gated URLs by
setting the two variables.

## One source of truth

`LearnerConfig.endpoints`, computed in `config.ts` (the only env reader):

- `LEARNER_PUBLIC_API_URL` — the URL clients use for the API. Default
  `http://127.0.0.1:<port>`. The topology is DERIVED: loopback host ⇒
  `same-machine`, anything else ⇒ `remote`. No separate enum to drift.
- `LEARNER_WEB_URL` — default `<api>/` when same-machine and the API serves
  a web build, else null.
- `LEARNER_GROWTHBOOK_URL` / `LEARNER_GROWTHBOOK_API_URL` — default null; the
  installer sets them for a loopback GrowthBook.
- Every URL is validated (absolute http/https, no credentials, query or
  fragment); a bad value fails startup.

Better Auth's `LEARNER_BASE_URL` stays separate: it is the human-session
origin, not the client API URL, and on the dev box they differ.

## Server → desktop

- `GET /api/health` (both runtimes) gains `product: 'learner-server'` and
  `contract: 1`. Nothing else is exposed unauthenticated: no version, no hash.
- RPC `getPairingEndpoints` (scope `app`, input `{ clientId }`, own device
  only): `{ topology, contract, serverVersion, endpointsVersion, api: {
  rpcBase, health }, web | null, growthbook: { app, api } | null, device: {
  pairingState, lastPairing } }`. `endpointsVersion` is a hash of the
  advertised URLs.
- `recordAppHeartbeat` output gains `endpointsVersion`, so the desktop
  refetches within one heartbeat after the server is reconfigured.

## Desktop → server

`recordAppHeartbeat` input gains optional `pairing: { apiUrlInUse,
endpointsVersionHeld, hostname, services: [{ name, url }] }`, stored on the
device row (`services` are display-only; the server never calls them).
`pairingState`: `ok` (apiUrlInUse is the advertised API URL and the version
is current), `stale` (version behind), `mismatch` (apiUrlInUse is not the
advertised API URL — e.g. the desktop goes through a tunnel the server does
not know about), `unknown` (no pairing report yet). No peer-address or
forwarded-header inference.

## Trust and keys

- No discovery. The pairing payload `{ apiUrl, clientId, apiKey }` is the
  trust anchor: the desktop pins `apiUrl` and never sends the key to another
  origin. If an advertised `api.rpcBase` differs from the pinned one, it asks
  the user; advertised web and GrowthBook URLs are open-in-browser only.
- `mint-api-key.ts --device <clientId> --pairing <file> [--owner <user>]`
  writes the payload as JSON to a mode-600 file (temp + rename; chowned to
  `--owner`). Never printed. same-machine: into the desktop user's config
  dir; remote: copied to the Mac over the operator's own channel.

## Installer

`bun scripts/install.ts --api-url URL [--growthbook] [--out DIR]` renders,
into `--out` (default `./install-out`, never `/tmp`), and changes nothing:

- `learner.env.fragment` with the endpoint keys (merged by hand or by
  `--apply` into `/etc/learner/learner.env`, never touching other keys);
- `deploy/growthbook/docker-compose.yml` + `growthbook.env`
  (`growthbook/growthbook` pinned image, ports bound to 127.0.0.1,
  `APP_ORIGIN`/`API_HOST` from the same values as the env fragment), when
  `--growthbook`;
- remote: `nginx-learner-api.conf`, a copy of the shipped
  `deploy/nginx/learner-api.conf` (machine routes only, no human gate).

`--apply` writes the env fragment and starts GrowthBook; it refuses if a
GrowthBook already listens on the ports. Key minting is a separate,
explicit `mint-api-key.ts` step.

Not in this round, stated plainly: a macOS user-mode install of the server
(launchd agents, Homebrew Postgres, Docker Desktop). The same-machine
CONFIGURATION is fully supported and tested (on Linux); packaging the server
for a Mac is the next piece.

## Tests

- **Unit:** endpoint derivation — both topologies, defaults, overrides,
  every invalid input; `endpointsVersion` stable and sensitive; pairing
  state for each case.
- **Integration (learner_test):** heartbeat with `pairing` is stored;
  `getPairingEndpoints` needs scope `app`, refuses another device's id.
- **E2E (`bun run gate`, new `pairing` stage, every runtime):**
  - same-machine: API on loopback; mint a `gate-*` device with `--pairing`;
    the desktop flow reads ONLY the pairing file, checks `/api/health`'s
    `product`, calls `getPairingEndpoints`, then follows every advertised URL:
    health 200, web index plus one JS asset it references with a JS content
    type (an SPA fallback returns 200 for anything); heartbeat → `ok`.
  - remote: a throwaway `nginx -c` running the SHIPPED
    `deploy/nginx/learner-api.conf` on a high port in front of the API, with
    `LEARNER_PUBLIC_API_URL` pointing at it; the same desktop flow through
    nginx; a heartbeat reporting the direct loopback URL → `mismatch`.
  - both runtimes return identical `/api/health` `product`/`contract`, and its
    key set is exactly `{ok, product, contract, db, role, uptime}`.
  - remote, through nginx: Better Auth and a REST route get nginx's 404 while
    the API serves both directly (the harness adds no catch-all of its own);
    a bad-token Read.ai delivery reaches the API's 401.
  - `mint-api-key --api-url` lands in the payload; `--owner nobody` (as root)
    owns the file (600) and its new parent dir (700).
  - gate devices are revoked at teardown and the revoke is VERIFIED: the old
    key gets 401 and no user, key or device row is left, or `--check` fails.
  - GrowthBook URLs are asserted to equal the rendered compose env; actually
    loading the UI is NOT covered (stated in the gate output).
- **Installer render test:** output for both topologies; the env fragment and
  compose env agree; the remote snippet is byte-identical to the shipped file.
- Every new test gets an adversarial review with mutations before merge.
  Round 1: 27 mutations, 7 survived; each survivor now has the check above,
  and the two must-fix ones (nginx catch-all, revoke) were re-run and caught.
  The new checks also found two bugs in the framework runtime: an invalid API key was a
  500 (Better Auth's `APIError` had no status mapping) and a bad-token Read.ai
  delivery was a 500 on an install without a habits database.
- Not covered: the `stale` state end to end (unit only); `localhost` vs
  `127.0.0.1` counts as `mismatch` (only trailing slashes are normalised).

## One-paste pairing and CI test devices (round 2, 2026-11-12)

Owner: pairing must be at most one paste, and the desktop's heavy tests run
against the real server as a separate test device that is cleaned up.
Everything below is a Pikku function with a wiring (Console, graph, inspector);
no ad-hoc REST, and `/api/health` is unchanged.

### Pairing code

`learner-pair-v1:<base64url(JSON PairingPayload)>`, the same `{ apiUrl,
clientId, apiKey }` the pairing file holds (`pairingCode()` in the contract).
Three producers, one helper (`mintDeviceKey`, `devices.ts`):

- `mint-api-key.ts --device <id> --pairing-code` prints the code (only with
  that flag: it is for the operator to copy).
- RPC `pairDesktop({ clientId })` → `{ clientId, pairingCode, link }`, scope
  `admin`, behind the web app's human sign-in (Settings > Integrations > Pair a
  desktop). `link` is `learner-desktop://pair?code=<code>`.
- RPC `createTestDevice` (below).

`ci-*` client ids are reserved for test devices: the script and `pairDesktop`
refuse them.

### Confined credentials

Two new principals hold a scope that CONFINES them (`CONFINED_SCOPES` in
`runtime/invoke.ts`): `checkAccess` refuses every external call by such a
session unless the function names that scope in `scopes` or `confined`. A new
function is closed to them until it opts in; the test enumerates the registry.

| Principal | User | Scopes | May call |
|---|---|---|---|
| CI minter | `ci-mint@ci.learner.invalid` (`mint-api-key.ts --ci-mint`, prints the key once) | `ci-mint` | `createTestDevice`, `revokeTestDevice`, `seedMasteryGain` |
| Test device | `ci-<runId>-<8 hex>@devices.learner.invalid` + a live `learner_test_devices` row | `app`, `test-device` | `recordAppHeartbeat`, `getPairingEndpoints`, `getMasteryNotifications`, `recordNotificationFeedback`, `getSpeakingCoachDesign` |

A test device reads and writes ONLY its own device user's mastery
(`masteryLearnerFor`), where a real device key reads the learner's. Its key
stops working (401) the moment its row is expired or revoked, before any sweep.

### RPCs

- `createTestDevice({ runId: /^[a-z0-9][a-z0-9-]{0,39}$/, ttlMinutes: 1..120 = 60 })`
  → `{ clientId, expiresAt, pairingCode }`. One transaction under an advisory
  lock: refuses (429) past 10 live test devices or 30 created in the last hour,
  then inserts the user and the `learner_test_devices` row; the key is minted
  after. A crash between the two leaves a keyless row the sweep removes at TTL.
- `revokeTestDevice({ clientId: /^ci-…-[0-9a-f]{8}$/ })` → `{ revoked }`. The
  same `{ revoked: false }` for an unknown id and for a real device's id.
- `seedMasteryGain({ clientId, kind: 'first_clear' = default, conceptId? })` →
  `{ kind, clientId, conceptId, runId, completedAt }`: one cited, high,
  fresh reading for the test device's user on an EXISTING concept (default: the
  first one it has no reading of), which the feed announces as `first_clear`.
  Refused (404, one message for unknown and real ids) unless the row is live.
  `kind` is an enum so a second seed (a prior-blind `gain`, which needs blind
  replicates in six sittings to pass the chance gate) is an added branch, not a
  new function.
- `getSpeakingCoachDesign({})` → `{ experimentId, trackingKey, name, status,
  phase, variations, metrics, variables }` (scope `app`, test devices allowed):
  `exp_speech_coach_settings_v1` read from GrowthBook's REST API with a READ-ONLY
  key (`LEARNER_GROWTHBOOK_READ_KEY` in `/etc/learner/growthbook-read.env`,
  optional `LEARNER_GROWTHBOOK_READ_URL`, default `http://127.0.0.1:3201`).
  5 s timeout per call, 5 min cache, 503 with the reason when unconfigured or
  unreachable. Never the admin key; nothing but those fields.
- Schedule `learner-test-device-sweep` (`*/5`) → `sweepTestDevices`: revokes
  expired rows and purges every revoked one; tombstones older than a day go.

### Storage (migration 0040)

`learner_test_devices(client_id PK CHECK ^ci-, user_id UNIQUE, run_id,
expires_at, created_at, revoked_at)`; the row IS the test flag. Revoke is two
statements in one transaction: mark the row (`revoked_at`, which waits on a
seed holding it `FOR UPDATE`), then purge, keyed only by revoked rows' user ids
and only when the user's email is `<client_id>@devices.learner.invalid`:
notification feedback → receipts → runs (their cascades), `apikey`, device row,
`user` (sessions, accounts cascade). The purge runs again on every sweep, so a
heartbeat that lands after a revoke is removed within one tick (feedback cannot
land: its FK to the deleted receipt refuses it). The assessment tables'
immutability trigger gains one exception, beside the curriculum purge's: under
`SET LOCAL learner.test_device_purge = 'on'` it admits deleting a run or receipt
only when the run's user is a REVOKED test device, so the database itself
refuses any other row. `learner_test_user(user_id)` is the one predicate for
cross-user reads.

### Out of every real query

Product reads are per learner (the owner's user id): feed, progress, baseline,
statistics, drift panel, both GrowthBook mastery fact tables (`user_id =` the
owner). Habit and call facts (`habits` DB) cannot receive test data: those RPCs
are closed to test devices. Cross-user reads take `NOT learner_test_user(..)`:
`getLearnerDesktopStatus`, `mastery-grader-calibration.ts`,
`uncited-dating-evaluation.ts`. Grader-noise reads need run digests, which a
seed never writes.

### Threat model

| Threat | Bound | Test |
|---|---|---|
| Leaked ci-mint key | creates ≤10 live / 30 per hour test devices, each confined as below; revokes and seeds test devices only; every other RPC 403 | registry sweep; cap; real-device revoke/seed refused |
| Leaked test-device key | its own heartbeat, endpoints, its own seeded mastery; never the owner's feed or feedback, no uploads, no habits; dead at TTL | owner run not visible, feedback on owner run `recorded: false`, uploads 403, expired key no session |
| TTL sweep vs a live run | the run sets its TTL (≤120 min); the key dies at TTL whether or not the sweep ran | unexpired device untouched by sweep |
| Revoke vs in-flight writes | seed: row lock; heartbeat: purged again next sweep; feedback: FK refuses | seed after revoke refused; late device row purged |
| Seeding a real device | refused in SQL (`INSERT … SELECT` from a live test row) | real id → 404, nothing written |
| Pairing code in logs/URLs | the server never logs it (only the script with `--pairing-code` prints); the deep link is handed to the OS, so it can land in browser history or the desktop's own logs: the desktop must not log it | functions' log lines carry no key |
| Enumerating client ids | revoke/seed answer identically for unknown and real ids; a device key gets the same 403 for any other id | — |
| Better Auth `/api/auth/*` with a confined key | can mint more keys for its OWN user only; revoke deletes every key of that user; remote nginx does not publish `/api/auth` | — |

Not built: the desktop side; a GrowthBook read key (the owner creates one,
role `readonly`); a `gain` seed kind; rotating `ci-mint` other than by
`--ci-mint --revoke` then `--ci-mint`.

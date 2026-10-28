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

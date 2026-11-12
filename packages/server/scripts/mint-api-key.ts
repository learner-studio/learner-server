import { chmodSync, chownSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PairingPayload } from '@learner/contract'
import { createDatabase } from '@learner/core/db/handle.js'
import { CI_MINT_EMAIL, CLIENT_ID_PATTERN, deviceEmail } from '../src/auth.js'
import { loadConfig } from '../src/config.js'
import { mintMachineKey, pairingCode } from '../src/devices.js'

/**
 * Mint a machine API key and write it to a mode-600 env file as
 * `LEARNER_API_KEY=…`. The key is never printed.
 *   bun --env-file=/etc/learner/db.env --env-file=/etc/learner/learner.env \
 *     packages/server/scripts/mint-api-key.ts <email> [--out /etc/learner/agent-key.env] [--force]
 *   ... mint-api-key.ts --device <clientId> [--out /etc/learner/device-<clientId>.key.env] [--force]
 *
 * `--device` creates the device user `<clientId>@devices.learner.invalid` when absent
 * (scope `app` only, see auth.ts) and mints that device's key. The desktop
 * fetches the file over its own SSH access straight into the Keychain.
 *
 * Pairing (docs/specs/server-desktop-pairing.md):
 *   ... --device <clientId> --pairing <file> [--owner <user>] [--api-url URL] [--force]
 * writes the pairing payload `{ apiUrl, clientId, apiKey }` as JSON instead, mode 600,
 * through a temp file and a rename, owned by `--owner` (the desktop's user) when given.
 * `apiUrl` is the URL this server advertises (LEARNER_PUBLIC_API_URL) unless overridden.
 *   ... --device <clientId> --pairing-code [--api-url URL]
 * PRINTS the one-paste pairing code `learner-pair-v1:…` (and writes no file): for the operator
 * to copy into the desktop. Printing is the point of the flag; nothing else prints a key.
 *   ... --device <clientId> --revoke
 * deletes the device user, every key it holds and its device row.
 *   ... --ci-mint            PRINTS a new key for the CI minter (scope `ci-mint`: it can only
 *                            create, seed and revoke test devices), once, for the CI secret.
 *   ... --ci-mint --revoke   deletes the CI minter and every key it holds.
 * `ci-*` device ids are reserved for test devices (createTestDevice).
 */
const args = process.argv.slice(2)
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const device = flag('--device')
const ciMint = args.includes('--ci-mint')
const email = ciMint ? CI_MINT_EMAIL : device ? deviceEmail(device) : args[0]
if (!email || email.startsWith('--')) throw new Error('usage: mint-api-key.ts <email> | --device <clientId> [--out path] [--force] | --ci-mint [--revoke]')
if (device && !CLIENT_ID_PATTERN.test(device)) throw new Error(`clientId must match ${CLIENT_ID_PATTERN}`)
if (device?.startsWith('ci-')) throw new Error('ci- client ids are reserved for test devices (createTestDevice)')
const pairing = flag('--pairing')
const printCode = args.includes('--pairing-code')
const printed = printCode || ciMint
const owner = flag('--owner')
if ((pairing || printCode || owner || flag('--api-url') || (args.includes('--revoke') && !ciMint)) && !device) throw new Error('--pairing, --pairing-code, --owner, --api-url and --revoke need --device')
const out = pairing ?? flag('--out') ?? (device ? `/etc/learner/device-${device}.key.env` : '/etc/learner/agent-key.env')
if (!args.includes('--revoke') && !printed && existsSync(out) && !args.includes('--force')) throw new Error(`${out} exists; pass --force to replace it`)

/** uid/gid of a local user, without a dependency: `id` exists on Linux and macOS. */
function ids(user: string): { uid: number; gid: number } {
  const id = (flagName: string) => {
    const proc = Bun.spawnSync(['id', flagName, user])
    if (proc.exitCode !== 0) throw new Error(`--owner: no local user ${user}`)
    return Number(proc.stdout.toString().trim())
  }
  return { uid: id('-u'), gid: id('-g') }
}

/** Mode 600 from the first byte, never readable half-written, then handed to its owner. */
function writePrivate(path: string, content: string, ownerIds?: { uid: number; gid: number }) {
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    if (ownerIds) chownSync(dirname(path), ownerIds.uid, ownerIds.gid)
  }
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, content, { mode: 0o600, flag: 'wx' })
  chmodSync(temp, 0o600)
  if (ownerIds) chownSync(temp, ownerIds.uid, ownerIds.gid)
  renameSync(temp, path)
}

const config = loadConfig('api')
const ownerIds = owner ? ids(owner) : undefined
const db = createDatabase(config.databaseUrl, { max: 2 })
try {
  if (args.includes('--revoke')) {
    const found = await db.kysely.selectFrom('user').select(['id']).where('email', '=', email).executeTakeFirst()
    const keys = found ? (await db.query('DELETE FROM apikey WHERE reference_id = $1', [found.id])).rowCount : 0
    if (found) await db.kysely.deleteFrom('user').where('id', '=', found.id).execute()
    if (device) await db.query('DELETE FROM learner_desktop_devices WHERE client_id = $1', [device])
    console.log(JSON.stringify({ event: ciMint ? 'ci-mint-revoked' : 'device-revoked', ...(device ? { device } : {}), keysDeleted: keys, userDeleted: Boolean(found) }))
    process.exit(0)
  }
  if (!device && !ciMint && !await db.kysely.selectFrom('user').select('id').where('email', '=', email).executeTakeFirst()) throw new Error(`No user with email ${email}`)
  const created = await mintMachineKey(db.kysely, config, email, ciMint ? 'ci-mint' : device ? `device:${device}` : 'learner-hook')
  const apiUrl = flag('--api-url') ?? config.endpoints.apiBase
  if (printed) {
    // The operator asked for the secret on this terminal: the code (or the CI key) alone on stdout, the receipt on stderr.
    console.log(ciMint ? created.key : pairingCode({ apiUrl, clientId: device!, apiKey: created.key }))
    console.error(JSON.stringify({ event: ciMint ? 'ci-mint-key-minted' : 'pairing-code-minted', keyId: created.keyId, userId: created.userId, ...(device ? { device, apiUrl } : {}) }))
    process.exit(0)
  }
  if (pairing) {
    const payload = PairingPayload.parse({ apiUrl, clientId: device, apiKey: created.key })
    writePrivate(out, `${JSON.stringify(payload, null, 2)}\n`, ownerIds)
  } else {
    writePrivate(out, `LEARNER_API_KEY=${created.key}\n`, ownerIds)
  }
  console.log(JSON.stringify({ event: 'api-key-minted', keyId: created.keyId, userId: created.userId, ...(device ? { device } : {}), out, ...(pairing ? { apiUrl } : {}) }))
} finally {
  await db.close()
}

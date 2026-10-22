import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '@learner/core/db/handle.js'
import { authConfigFromEnv, CLIENT_ID_PATTERN, createAuth, deviceEmail } from '../src/auth.js'
import { loadConfig } from '../src/config.js'

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
 */
const args = process.argv.slice(2)
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const device = flag('--device')
const email = device ? deviceEmail(device) : args[0]
if (!email || email.startsWith('--')) throw new Error('usage: mint-api-key.ts <email> | --device <clientId> [--out path] [--force]')
if (device && !CLIENT_ID_PATTERN.test(device)) throw new Error(`clientId must match ${CLIENT_ID_PATTERN}`)
const out = flag('--out') ?? (device ? `/etc/learner/device-${device}.key.env` : '/etc/learner/agent-key.env')
if (existsSync(out) && !args.includes('--force')) throw new Error(`${out} exists; pass --force to replace it`)

const config = loadConfig('api')
const db = createDatabase(config.databaseUrl, { max: 2 })
try {
  let user = await db.kysely.selectFrom('user').select(['id']).where('email', '=', email).executeTakeFirst()
  if (!user && device) {
    const now = new Date()
    user = await db.kysely.insertInto('user')
      .values({ id: randomUUID(), name: `learner-desktop ${device}`, email, emailVerified: true, createdAt: now, updatedAt: now })
      .returning(['id']).executeTakeFirstOrThrow()
  }
  if (!user) throw new Error(`No user with email ${email}`)
  const auth = createAuth(db.kysely, authConfigFromEnv(config))
  const created = await auth.api.createApiKey({ body: { userId: user.id, name: device ? `device:${device}` : 'learner-hook' } })
  writeFileSync(out, `LEARNER_API_KEY=${created.key}\n`, { mode: 0o600 })
  chmodSync(out, 0o600)
  console.log(JSON.stringify({ event: 'api-key-minted', keyId: created.id, userId: user.id, ...(device ? { device } : {}), out }))
} finally {
  await db.close()
}

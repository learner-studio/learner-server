import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { createDatabase } from '@learner/core/db/handle.js'
import { authConfigFromEnv, createAuth } from '../src/auth.js'
import { loadConfig } from '../src/config.js'

/**
 * Mint a machine API key for a user and write it to a mode-600 env file as
 * `LEARNER_API_KEY=…`. The key is never printed.
 *   bun --env-file=/etc/learner/db.env --env-file=/etc/learner/learner.env \
 *     packages/server/scripts/mint-api-key.ts <email> [--out /etc/learner/agent-key.env] [--force]
 */
const args = process.argv.slice(2)
const email = args[0]
const out = args.includes('--out') ? args[args.indexOf('--out') + 1]! : '/etc/learner/agent-key.env'
if (!email) throw new Error('usage: mint-api-key.ts <email> [--out path] [--force]')
if (existsSync(out) && !args.includes('--force')) throw new Error(`${out} exists; pass --force to replace it`)

const config = loadConfig('api')
const db = createDatabase(config.databaseUrl, { max: 2 })
try {
  const user = await db.kysely.selectFrom('user').select(['id']).where('email', '=', email).executeTakeFirst()
  if (!user) throw new Error(`No user with email ${email}`)
  const auth = createAuth(db.kysely, authConfigFromEnv(config))
  const created = await auth.api.createApiKey({ body: { userId: user.id, name: 'learner-hook' } })
  writeFileSync(out, `LEARNER_API_KEY=${created.key}\n`, { mode: 0o600 })
  chmodSync(out, 0o600)
  console.log(JSON.stringify({ event: 'api-key-minted', keyId: created.id, userId: user.id, out }))
} finally {
  await db.close()
}

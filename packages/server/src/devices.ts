import { randomUUID } from 'node:crypto'
import { CompiledQuery, type Kysely } from 'kysely'
import type { z } from 'zod'
import { PairingPayload } from '@learner/contract'
import type { DB } from '@learner/core/db/db.types.js'
import type { DatabaseHandle } from '@learner/core/db/handle.js'
import { createAuth } from './auth.js'
import type { LearnerConfig } from './config.js'

/**
 * Machine credentials and test devices (docs/specs/server-desktop-pairing.md, round 2).
 * The one place a device or CI key is minted (mint-api-key.ts, pairDesktop, createTestDevice)
 * and the one place a test device and everything it wrote is deleted.
 */

/** `learner-pair-v1:<base64url(JSON payload)>`. It carries the key: return it, never log it. */
export const pairingCode = (payload: z.infer<typeof PairingPayload>): string =>
  `learner-pair-v1:${Buffer.from(JSON.stringify(PairingPayload.parse(payload))).toString('base64url')}`

/** One more API key for a machine user (`<clientId>@devices…` or the CI minter), creating the user when absent. */
export async function mintMachineKey(kysely: Kysely<DB>, config: Pick<LearnerConfig, 'authSecret' | 'baseUrl' | 'adminEmails'>, email: string, keyName: string) {
  let user = await kysely.selectFrom('user').select('id').where('email', '=', email).executeTakeFirst()
  if (!user) {
    const now = new Date()
    user = await kysely.insertInto('user').values({ id: randomUUID(), name: keyName, email, emailVerified: true, createdAt: now, updatedAt: now })
      .returning('id').executeTakeFirstOrThrow()
  }
  const auth = createAuth(kysely, { secret: config.authSecret, baseUrl: config.baseUrl, adminEmails: config.adminEmails })
  const created = await auth.api.createApiKey({ body: { userId: user.id, name: keyName } })
  return { userId: user.id, keyId: created.id, key: created.key }
}

/**
 * Everything revoked test devices wrote, keyed ONLY by user ids taken from revoked
 * `learner_test_devices` rows ($1: one client id, or null for every tombstone), and the user
 * only when its email is that test device's. Idempotent: the sweep runs it each tick, which
 * also removes a heartbeat row that landed after the revoke. Deletes run in FK order.
 */
const PURGE = [
  `SELECT client_id, user_id FROM learner_test_devices WHERE revoked_at IS NOT NULL AND ($1::text IS NULL OR client_id = $1)`,
  `DELETE FROM learning_notification_feedback WHERE run_id IN (SELECT run_id FROM learning_concept_assessment_runs WHERE user_id IN (SELECT user_id FROM t))`,
  `DELETE FROM learning_concept_assessment_receipts WHERE run_id IN (SELECT run_id FROM learning_concept_assessment_runs WHERE user_id IN (SELECT user_id FROM t))`,
  `DELETE FROM learning_concept_assessment_runs WHERE user_id IN (SELECT user_id FROM t)`,
  `DELETE FROM apikey WHERE reference_id IN (SELECT user_id FROM t)`,
  `DELETE FROM learner_desktop_devices d USING t WHERE d.client_id = t.client_id AND d.user_id = t.user_id`,
  `DELETE FROM "user" u USING t WHERE u.id = t.user_id AND u.email = t.client_id || '@devices.learner.invalid'`,
]

/**
 * Revoke one test device (`clientId`) or every expired one (null), then purge what every revoked
 * one wrote, in one transaction. Marking first takes the row lock a concurrent seed holds, so a
 * seed either lands before (and is purged) or sees the row revoked. Returns the ids revoked now.
 */
export async function revokeTestDevices(db: DatabaseHandle, clientId: string | null): Promise<string[]> {
  return db.snake.transaction().execute(async (trx) => {
    const q = <R>(text: string) => trx.executeQuery<R>(CompiledQuery.raw(text, [clientId]))
    const marked = await q<{ client_id: string }>(`UPDATE learner_test_devices SET revoked_at = now()
      WHERE revoked_at IS NULL AND (client_id = $1 OR ($1::text IS NULL AND expires_at <= now())) RETURNING client_id`)
    const [select, ...deletes] = PURGE
    // The assessment tables' immutability trigger admits these deletes only for a revoked test device's runs (0040).
    await trx.executeQuery(CompiledQuery.raw(`SELECT set_config('learner.test_device_purge', 'on', true)`))
    for (const statement of deletes) await q(`WITH t AS (${select}) ${statement}`)
    return marked.rows.map((r) => r.client_id)
  })
}

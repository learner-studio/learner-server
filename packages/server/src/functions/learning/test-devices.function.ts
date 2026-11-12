import { randomBytes, randomUUID } from 'node:crypto'
import { CompiledQuery } from 'kysely'
import {
  CreateTestDeviceInput, CreateTestDeviceOutput, RevokeTestDeviceInput, RevokeTestDeviceOutput, SeedMasteryGainInput, SeedMasteryGainOutput,
} from '@learner/contract'
import { NotFoundError, TooManyRequestsError, UnprocessableContentError } from '@learner/core/runtime/errors.js'
import { deviceEmail } from '../../auth.js'
import { mintMachineKey, pairingCode, revokeTestDevices } from '../../devices.js'
import { defineFunction, defineVoidFunction } from '../../runtime/define.js'

/**
 * CI test devices (docs/specs/server-desktop-pairing.md, round 2). Only the `ci-mint` credential
 * reaches these; a test device's own key reaches a confined handful of desktop RPCs.
 */
/** What one leaked ci-mint key can hold at once, and make in an hour. */
export const MAX_LIVE_TEST_DEVICES = 10
export const MAX_TEST_DEVICES_PER_HOUR = 30

export const createTestDevice = defineFunction({
  title: 'Create a CI test device (ci-<runId>-<rand>) that expires, and return its pairing code',
  description: 'Capped at 10 live and 30 per hour. The device reads only its own mastery and is deleted with everything it wrote.',
  expose: true, scopes: ['ci-mint'],
  input: CreateTestDeviceInput, output: CreateTestDeviceOutput,
  func: async ({ db, kysely, config, logger }, { runId, ttlMinutes }) => {
    const clientId = `ci-${runId}-${randomBytes(4).toString('hex')}`
    const userId = randomUUID()
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000)
    // The cap, the user and the test flag in one transaction; the lock makes the cap exact under concurrent creates.
    await db.snake.transaction().execute(async (trx) => {
      const q = <R>(text: string, params: unknown[] = []) => trx.executeQuery<R>(CompiledQuery.raw(text, params))
      await q(`SELECT pg_advisory_xact_lock(hashtext('learner_test_devices'))`)
      const { live, recent } = (await q<{ live: number; recent: number }>(`SELECT
        count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now())::int AS live,
        count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS recent FROM learner_test_devices`)).rows[0]!
      if (live >= MAX_LIVE_TEST_DEVICES) throw new TooManyRequestsError(`${live} test devices are live (cap ${MAX_LIVE_TEST_DEVICES}): revoke some first`)
      if (recent >= MAX_TEST_DEVICES_PER_HOUR) throw new TooManyRequestsError(`${recent} test devices made in the last hour (cap ${MAX_TEST_DEVICES_PER_HOUR})`)
      await q(`INSERT INTO "user"(id, name, email, email_verified) VALUES ($1, $2, $3, true)`, [userId, `test device ${clientId}`, deviceEmail(clientId)])
      await q(`INSERT INTO learner_test_devices(client_id, user_id, run_id, expires_at) VALUES ($1, $2, $3, $4)`, [clientId, userId, runId, expiresAt])
    })
    // A crash here leaves a keyless test device: nothing can use it, and the sweep removes it at its TTL.
    const { key, keyId } = await mintMachineKey(kysely, config, deviceEmail(clientId), `device:${clientId}`)
    logger.info({ event: 'test-device-created', clientId, runId, keyId, expiresAt: expiresAt.toISOString() })
    return { clientId, expiresAt: expiresAt.toISOString(), pairingCode: pairingCode({ apiUrl: config.endpoints.apiBase, clientId, apiKey: key }) }
  },
})

export const revokeTestDevice = defineFunction({
  title: 'Revoke a CI test device and delete every row it wrote',
  description: 'Only rows flagged test are touched (the SQL keys on learner_test_devices); a real device id answers revoked: false.',
  expose: true, scopes: ['ci-mint'],
  input: RevokeTestDeviceInput, output: RevokeTestDeviceOutput,
  func: async ({ db, logger }, { clientId }) => {
    const revoked = (await revokeTestDevices(db, clientId)).length > 0
    logger.info({ event: 'test-device-revoked', clientId, revoked })
    return { revoked }
  },
})

export const sweepTestDevices = defineVoidFunction({
  title: 'Revoke expired CI test devices, purge every revoked one, and drop day-old tombstones',
  func: async ({ db, logger }) => {
    const expired = await revokeTestDevices(db, null)
    const dropped = (await db.query(`DELETE FROM learner_test_devices WHERE revoked_at < now() - interval '1 day'`)).rowCount
    if (expired.length || dropped) logger.info({ event: 'test-devices-swept', expired, tombstonesDropped: dropped })
  },
})

/**
 * A reading the device's feed announces, written for the test device's own user only. The test row is
 * locked FOR UPDATE for the whole transaction, so a revoke waits for the seed or the seed finds it revoked.
 */
export const seedMasteryGain = defineFunction({
  title: 'Seed a mastery notification for a CI test device (refused for any other device)',
  description: 'kind first_clear: one cited, high-confidence, fresh reading on an existing concept the device has not read.',
  expose: true, scopes: ['ci-mint'],
  input: SeedMasteryGainInput, output: SeedMasteryGainOutput,
  func: async ({ db, logger }, { clientId, kind, conceptId }) => db.snake.transaction().execute(async (trx) => {
    const q = <R>(text: string, params: unknown[]) => trx.executeQuery<R>(CompiledQuery.raw(text, params))
    const device = (await q<{ user_id: string }>(`SELECT user_id FROM learner_test_devices
      WHERE client_id = $1 AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`, [clientId])).rows[0]
    if (!device) throw new NotFoundError(`${clientId} is not a live test device`)
    const concept = (await q<{ id: string }>(`SELECT c.id FROM learning_concepts c WHERE ($2::text IS NULL OR c.id = $2)
      AND NOT EXISTS (SELECT 1 FROM learning_concept_assessment_runs r WHERE r.user_id = $1 AND r.concept_id = c.id) ORDER BY c.id LIMIT 1`,
      [device.user_id, conceptId ?? null])).rows[0]
    if (!concept) throw new UnprocessableContentError(conceptId ? `${conceptId} is not a concept, or ${clientId} already has a reading of it` : 'no concept left to seed')
    const runId = randomUUID(), messageId = `seed-${runId}`
    const now = new Date(), said = new Date(now.getTime() - 60_000).toISOString(), completedAt = now.toISOString()
    const quote = 'A seeded explanation, in the learner\'s own words, for a CI test device.'
    const snapshot = { seed: kind, evidence: [{ id: messageId, role: 'user', occurredAt: said, text: quote }] }
    const receipt = { status: 'completed', completedAt, assessment: { conceptId: concept.id, understandingPercent: 80, confidence: 'high',
      demonstrated: [{ quote, sourceId: messageId, description: 'seeded' }], gaps: [], nextCheck: 'none: seeded', needsReview: false } }
    await q(`INSERT INTO learning_concept_assessment_runs(run_id, user_id, request_id, concept_id, node_version, input_hash, snapshot, created_at)
      VALUES ($1, $2, $1, $3, 'test-device-seed', 'test-device-seed', $4::jsonb, $5)`, [runId, device.user_id, concept.id, JSON.stringify(snapshot), said])
    await q(`INSERT INTO learning_concept_assessment_receipts(run_id, receipt, completed_at) VALUES ($1, $2::jsonb, $3)`, [runId, JSON.stringify(receipt), completedAt])
    logger.info({ event: 'test-device-seeded', clientId, kind, conceptId: concept.id, runId })
    return { kind, clientId, conceptId: concept.id, runId, completedAt }
  }),
})

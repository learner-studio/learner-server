import { randomBytes, randomUUID } from 'node:crypto'
import { CompiledQuery } from 'kysely'
import {
  CreateTestDeviceInput, CreateTestDeviceOutput, RevokeTestDeviceInput, RevokeTestDeviceOutput, SeedMasteryGainInput, SeedMasteryGainOutput,
} from '@learner/contract'
import { FALLBACK_BLIND_SD } from '@learner/core/lib/learning/grader-noise.js'
import { combineReplicates } from '@learner/core/lib/learning/mastery-change-statistics.js'
import type { GainRule } from '@learner/core/lib/learning/mastery-notifications.js'
import { NotFoundError, TooManyRequestsError, UnprocessableContentError } from '@learner/core/runtime/errors.js'
import { deviceEmail } from '../../auth.js'
import { mintMachineKey, pairingCode, revokeTestDevices } from '../../devices.js'
import { pikkuFunc, pikkuVoidFunc } from '#pikku/function'

/**
 * CI test devices (docs/specs/server-desktop-pairing.md, round 2). Only the `ci-mint` credential
 * reaches these; a test device's own key reaches a confined handful of desktop RPCs.
 */
/** What one leaked ci-mint key can hold at once, and make in an hour. */
export const MAX_LIVE_TEST_DEVICES = 10
export const MAX_TEST_DEVICES_PER_HOUR = 30

export const createTestDevice = pikkuFunc({
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
    // A crash here leaves a keyless test device the sweep removes at its TTL. If the sweep or a revoke purged it
    // first, the mint refuses rather than recreate the user (which would hold a plain, unconfined `app` key).
    const { key, keyId } = await mintMachineKey(kysely, config, deviceEmail(clientId), `device:${clientId}`, false)
    logger.info({ event: 'test-device-created', clientId, runId, keyId, expiresAt: expiresAt.toISOString() })
    return { clientId, expiresAt: expiresAt.toISOString(), pairingCode: pairingCode({ apiUrl: config.endpoints.apiBase, clientId, apiKey: key }) }
  },
})

export const revokeTestDevice = pikkuFunc({
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

export const sweepTestDevices = pikkuVoidFunc({
  title: 'Revoke expired CI test devices, purge every revoked one, and drop day-old tombstones',
  func: async ({ db, logger }) => {
    const expired = await revokeTestDevices(db, null)
    const dropped = (await db.query(`DELETE FROM learner_test_devices WHERE revoked_at < now() - interval '1 day'`)).rowCount
    if (expired.length || dropped) logger.info({ event: 'test-devices-swept', expired, tombstonesDropped: dropped })
  },
})

/**
 * The calibration a test device's feed is read with (docs/specs/server-desktop-pairing.md, "Seeding").
 * The gain rule's SQL, the noise margin, the drift clearance and the chance gate over sittings, is
 * the one every learner gets; only its two measured inputs are declared, because neither can be
 * measured for a synthetic learner without writing global rows: the grader drift interval (the weekly
 * panel: none on a fresh database, so no gain could pass anywhere) and σ_e (a new learner's fallback
 * puts the margin near 19 points, so a +15 is correctly not a gain). Never used for a real learner.
 */
export const TEST_DEVICE_GAIN_RULE: GainRule = { noise: { graderSd: FALLBACK_BLIND_SD, evidenceSd: 3, replicateCredit: true }, drift: [0, 0] }
/** Fixed synthetic text: never a real learner's words. */
export const SEED_QUOTE = 'A seeded explanation, in the learner\'s own words, for a CI test device.'
/** Prior-blind gradings per seeded measurement, and the earlier gain sittings the chance gate needs (it passes from 6). */
const SEED_GRADINGS = 4, CHANCE_SITTINGS = 6
const HOUR = 3_600_000

/**
 * A notification the device's feed announces, written for the test device's own user only, on existing
 * concepts it has no reading of (concepts are global: never created here). The test row is locked FOR
 * UPDATE for the whole transaction, so a revoke waits for the seed or the seed finds it revoked.
 * It is the history a real learner leaves when a gain is announced: six earlier uncited gains, one per
 * sitting an hour apart, on six other concepts (uncited, so not news and never shown; they are the
 * sittings the chance gate counts), then on the target a measurement of 50 % and, a minute ago, a
 * cited 65 %. Every measurement is SEED_GRADINGS prior-blind gradings, as the replicate lane writes them.
 * Runs carry no grader model, so no grader-noise or drift-panel query (they filter on it) ever reads them.
 */
export const seedMasteryGain = pikkuFunc({
  title: 'Seed a mastery notification for a CI test device (refused for any other device)',
  description: 'A 50 % -> 65 % gain with a quote, through the real feed and its chance gate. Existing concepts the device has not read.',
  expose: true, scopes: ['ci-mint'],
  input: SeedMasteryGainInput, output: SeedMasteryGainOutput,
  func: async ({ db, logger }, { clientId, conceptId }) => db.snake.transaction().execute(async (trx) => {
    const q = <R>(text: string, params: unknown[]) => trx.executeQuery<R>(CompiledQuery.raw(text, params))
    const device = (await q<{ user_id: string }>(`SELECT user_id FROM learner_test_devices
      WHERE client_id = $1 AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`, [clientId])).rows[0]
    if (!device) throw new NotFoundError(`${clientId} is not a live test device`)
    const needed = 1 + CHANCE_SITTINGS
    const concepts = (await q<{ id: string }>(`SELECT c.id FROM learning_concepts c
      WHERE NOT EXISTS (SELECT 1 FROM learning_concept_assessment_runs r WHERE r.user_id = $1 AND r.concept_id = c.id)
      ORDER BY c.id = $2 DESC, c.id LIMIT $3`, [device.user_id, conceptId ?? null, needed])).rows.map((r) => r.id)
    if (concepts.length < needed || (conceptId && concepts[0] !== conceptId)) {
      throw new UnprocessableContentError(conceptId && concepts[0] !== conceptId
        ? `${conceptId} is not a concept, or ${clientId} already has a reading of it` : `${needed} concepts ${clientId} has not read are needed, ${concepts.length} left`)
    }
    const reading = async (concept: string, percent: number, said: number, graded: number, cited: boolean) => {
      const confidence = 'medium', gradings = SEED_GRADINGS
      const runId = randomUUID(), messageId = `seed-${runId}`, completedAt = new Date(graded).toISOString()
      const snapshot = { seed: 'gain', evidence: [{ id: messageId, role: 'user', occurredAt: new Date(said).toISOString(), text: SEED_QUOTE }] }
      const receipt = { status: 'completed', completedAt, assessment: { conceptId: concept, understandingPercent: percent, confidence,
        demonstrated: cited ? [{ quote: SEED_QUOTE, sourceId: messageId, description: 'seeded' }] : [], gaps: [], nextCheck: 'none: seeded', needsReview: false } }
      await q(`INSERT INTO learning_concept_assessment_runs(run_id, user_id, request_id, concept_id, node_version, input_hash, snapshot, created_at)
        VALUES ($1, $2, $1, $3, 'test-device-seed', 'test-device-seed', $4::jsonb, $5)`, [runId, device.user_id, concept, JSON.stringify(snapshot), completedAt])
      await q(`INSERT INTO learning_concept_assessment_replicate_plans(run_id, replicates) VALUES ($1, $2)`, [runId, gradings])
      await q(`INSERT INTO learning_concept_assessment_receipts(run_id, receipt, completed_at) VALUES ($1, $2::jsonb, $3)`, [runId, JSON.stringify(receipt), completedAt])
      const c = combineReplicates(Array.from({ length: gradings }, () => ({ percent, confidence })))!
      await q(`INSERT INTO learning_concept_assessment_replicate_summaries(run_id, replicates, mean_percent, display_percent, sd, confidence, combined_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [runId, c.replicates, c.meanPercent, c.displayPercent, c.sd, c.confidence, completedAt])
      return { runId, completedAt }
    }
    const now = Date.now(), [target, ...others] = concepts as [string, ...string[]]
    for (const [i, other] of others.entries()) {
      await reading(other, 40, now - 26 * HOUR, now - 25 * HOUR + i * 60_000, false)
      await reading(other, 70, now - (CHANCE_SITTINGS + 1 - i) * HOUR, now - (CHANCE_SITTINGS + 1 - i) * HOUR + HOUR / 2, false)
    }
    await reading(target, 50, now - 26 * HOUR, now - 25 * HOUR - 60_000, false)
    const { runId, completedAt } = await reading(target, 65, now - 60_000, now, true)
    logger.info({ event: 'test-device-seeded', clientId, conceptId: target, runId })
    return { clientId, conceptId: target, runId, completedAt }
  }),
})

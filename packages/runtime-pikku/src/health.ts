import { pikkuSessionlessFunc } from '#pikku/function'
import { LEARNER_PRODUCT, PAIRING_CONTRACT } from '@learner/server/pairing.js'
import { ServiceUnavailableError } from '@learner/core/runtime/errors.js'

/** GET /api/health, as under the standalone runtime: 503 when the database is unreachable. */
export const learnerHealth = pikkuSessionlessFunc<void, { ok: boolean; product: string; contract: number; db: string; role: string; uptime: number }>({
  auth: false,
  func: async ({ db, config }) => {
    const ok = await db.query('SELECT 1').then(() => true, () => false)
    if (!ok) throw new ServiceUnavailableError('database unreachable')
    return { ok, product: LEARNER_PRODUCT, contract: PAIRING_CONTRACT, db: 'postgres', role: config.role, uptime: Math.round(process.uptime()) }
  },
})

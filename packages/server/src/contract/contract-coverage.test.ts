import { describe, expect, test } from 'bun:test'
import { pikkuState } from '@pikku/core/state'
import { RPC } from '@learner/contract'
import { LIVE_CATALOG, LIVE_CATALOG_VERSION } from '@learner/core/lib/learning/learning-live-catalog.js'
import '#pikku/function/pikku-functions-meta.gen.js'

/**
 * The contract may only name functions the server actually exposes over /rpc. Judged from Pikku's function meta,
 * which holds every function, shared (its generated wrapper) or Pikku-native.
 */
describe('RPC contract vs server functions', () => {
  const meta = pikkuState(null, 'function', 'meta')
  for (const name of Object.keys(RPC)) {
    test(`${name} is an exposed server function`, () => {
      expect(meta[name]).toBeDefined()
      expect(meta[name]!.expose).toBe(true)
    })
  }

  test('the server catalog satisfies the contract output', () => {
    expect(RPC.getLearningFeedbackCatalog.output.parse({ catalogVersion: LIVE_CATALOG_VERSION, catalog: LIVE_CATALOG }).catalog.length).toBe(LIVE_CATALOG.length)
  })
})

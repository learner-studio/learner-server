import { describe, expect, test } from 'bun:test'
import { RPC } from '@learner/contract'
import { LIVE_CATALOG, LIVE_CATALOG_VERSION } from '@learner/core/lib/learning/learning-live-catalog.js'
import { buildRegistry } from '../functions/registry.js'

/** The contract may only name functions the server actually exposes over /rpc. */
describe('RPC contract vs server registry', () => {
  const registry = buildRegistry()
  for (const name of Object.keys(RPC)) {
    test(`${name} is an exposed server function`, () => {
      const fn = registry.get(name)
      expect(fn).toBeDefined()
      expect(fn!.meta.expose).toBe(true)
    })
  }

  test('the server catalog satisfies the contract output', () => {
    expect(RPC.getLearningFeedbackCatalog.output.parse({ catalogVersion: LIVE_CATALOG_VERSION, catalog: LIVE_CATALOG }).catalog.length).toBe(LIVE_CATALOG.length)
  })
})

import { describe, expect, test } from 'bun:test'

import { getKysely } from '../db.js'
import { LearningCurriculumStore } from './learning-curriculum-store.js'

/**
 * One curriculum that does not parse (here: zero lanes, which LearningGraphSchema rejects) must not take
 * down the list readers. The live hook reads listGraphs on every turn, so a throw there made every turn of
 * every learner fail open. The broken row lives only inside a transaction that is rolled back, so no other
 * test file ever sees it.
 */
class Rollback extends Error {}

describe('curriculum list readers skip a curriculum that does not parse', () => {
  test('a zero-lane curriculum is left out; every other curriculum is still listed', async () => {
    const db = await getKysely()
    const id = `unparseable-test-${process.pid}-${Date.now()}`
    const owner = `${id}-owner`
    let seen: { all: string[]; visible: string[]; seeds: string[] } | null = null
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('learningCurricula').values({
        id, title: id, description: id, domain: 'test', status: 'draft', sourceKind: 'generated', ownerUserId: owner,
        provenance: { kind: 'model-generated', source: 'test', version: '1' },
      }).execute()
      const store = new LearningCurriculumStore(trx)
      await expect(store.getGraph(id)).rejects.toThrow()
      const seeds = (await trx.selectFrom('learningCurricula').select('id').where('sourceKind', '=', 'seed').execute()).map((r) => r.id)
      seen = { seeds, all: (await store.listGraphs()).map((g) => g.curriculum.id), visible: (await store.listGraphsVisibleTo(owner)).map((g) => g.curriculum.id) }
      throw new Rollback()
    }).catch((error) => { if (!(error instanceof Rollback)) throw error })
    expect(seen!.all).not.toContain(id)
    expect(seen!.visible).not.toContain(id)
    // The shipped library (stable while other test files add and drop their own curricula) is all still listed.
    expect(seen!.seeds.length).toBeGreaterThan(0)
    for (const seed of seen!.seeds) expect(seen!.all).toContain(seed)
  })
})

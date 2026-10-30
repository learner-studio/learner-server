import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getKysely } from '@learner/core/db.js'
import { masteryLearnerFor } from './mastery-notifications.function.js'

// The device key reads the first LEARNER_ADMIN_EMAILS account. Config lowercases that list
// (auth.ts), while the stored email keeps whatever case the account was created with.
describe.skipIf(!process.env.TEST_DATABASE_URL)('masteryLearnerFor (learner_test)', () => {
  const id = `mlf-${randomUUID()}`
  const stored = `Mixed.Case-${id}@Example.org`
  beforeAll(async () => {
    const kysely = await getKysely()
    await kysely.insertInto('user').values({ id, name: 'mlf', email: stored, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } as never).execute()
  })
  afterAll(async () => { await (await getKysely()).deleteFrom('user').where('id', '=', id).execute() })

  test('a device key finds a learner whose stored email has capitals', async () => {
    const services = { config: { adminEmails: [stored.toLowerCase()] }, kysely: await getKysely() } as never
    expect(await masteryLearnerFor(services, { userId: 'u-dev', email: 'my-mac@devices.learner.invalid', scopes: ['app'] } as never)).toBe(id)
  })
})

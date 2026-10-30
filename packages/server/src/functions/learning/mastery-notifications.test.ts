import { expect, test } from 'bun:test'
import { masteryLearnerFor } from './mastery-notifications.function.js'

// A stub of the one query masteryLearnerFor makes: the user id for an email.
const services = (adminEmails: string[], users: Record<string, string>) => ({
  config: { adminEmails },
  kysely: { selectFrom: () => ({ select: () => ({ where: (_c: string, _o: string, email: string) => ({ executeTakeFirst: async () => users[email] ? { id: users[email] } : undefined }) }) }) },
}) as never

test('an admin reads their own mastery; a device key reads the first admin\'s; anyone else is refused', async () => {
  const s = services(['ben@example.org', 'other@example.org'], { 'ben@example.org': 'u-ben' })
  expect(await masteryLearnerFor(s, { userId: 'u-other', email: 'other@example.org', scopes: ['admin'] } as never)).toBe('u-other')
  expect(await masteryLearnerFor(s, { userId: 'u-dev', email: 'my-mac@devices.learner.invalid', scopes: ['app'] } as never)).toBe('u-ben')
  await expect(masteryLearnerFor(s, { userId: 'u-x', email: 'x@example.org', scopes: [] } as never)).rejects.toThrow('admin or app')
  // `app` without a device email (not a device user) is refused too.
  await expect(masteryLearnerFor(s, { userId: 'u-x', email: 'x@example.org', scopes: ['app'] } as never)).rejects.toThrow('admin or app')
  await expect(masteryLearnerFor(services([], {}), { userId: 'u-dev', email: 'my-mac@devices.learner.invalid', scopes: ['app'] } as never)).rejects.toThrow('No learner account')
})

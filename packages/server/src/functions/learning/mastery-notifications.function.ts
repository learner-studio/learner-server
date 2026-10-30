import { defineFunction } from '../../runtime/define.js'
import { ForbiddenError } from '@learner/core/runtime/errors.js'
import type { Session } from '@learner/core/runtime/index.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { coachBaseline, learningBaseline, masteryNotifications, recordNotificationFeedback as saveNotificationFeedback } from '@learner/core/lib/learning/mastery-notifications.js'
import { BaselineStatus, GetMasteryNotificationsInput, GetMasteryNotificationsOutput, RecordNotificationFeedbackInput, RecordNotificationFeedbackOutput } from '@learner/contract'
import { z } from 'zod'
import { deviceClientId } from '../../auth.js'
import type { Services } from '../../runtime/define.js'

/**
 * Whose mastery a caller reads (docs/specs/mastery-notifications.md S2). An admin
 * reads their own. A device key (scope `app`) signs in as its own device user,
 * which has no readings, so it reads the learner's: on a single-learner install
 * that is the first LEARNER_ADMIN_EMAILS account. Anyone else is refused.
 */
export async function masteryLearnerFor({ config, kysely }: Pick<Services, 'config' | 'kysely'>, session: Session): Promise<string> {
  if (session.scopes.includes('admin')) return session.userId
  if (!session.scopes.includes('app') || !deviceClientId(session)) throw new ForbiddenError('Missing scope: admin or app')
  const email = config.adminEmails[0]
  const learner = email ? await kysely.selectFrom('user').select('id').where('email', '=', email).executeTakeFirst() : undefined
  if (!learner) throw new ForbiddenError('No learner account on this server (LEARNER_ADMIN_EMAILS)')
  return learner.id
}

export const getMasteryNotifications = defineFunction({
  title: 'Mastery gains and first clear readings since a time, newest first',
  description: 'Positive only: first high-confidence readings and gains of at least +10 over the best earlier medium/high reading. Device key or admin session.',
  expose: true, readonly: true,
  input: GetMasteryNotificationsInput, output: GetMasteryNotificationsOutput,
  func: async (services, { since, limit }, { session }) => {
    const userId = await masteryLearnerFor(services, session)
    return { notifications: await masteryNotifications(metaDbQuery, userId, { since: since ?? '-infinity', limit }) }
  },
})

export const getBaselineStatus = defineFunction({
  title: 'How far the learning and Speaking Coach baselines are, and the pace toward them',
  description: 'Learning: concepts tracking (one high or two medium readings) out of those the learner was exposed to. Coach: current-version speech turns per arm against the sample size the experiment needs.',
  expose: true, readonly: true,
  input: z.object({}), output: BaselineStatus,
  func: async (services, _data, { session }) => {
    const userId = await masteryLearnerFor(services, session)
    const learning = await learningBaseline(metaDbQuery, userId)
    const coach = services.config.habitsDatabaseUrl ? coachBaseline(await services.learnerDesktopHabits().coachArmCounts()) : null
    return {
      learning: { have: learning.have, need: learning.need, pacePerDay: learning.pacePerDay, daysLeft: learning.daysLeft },
      coach,
    }
  },
})

export const recordNotificationFeedback = defineFunction({
  title: 'What the learner did with a mastery notification (opened, nice, not right, ignored)',
  description: 'Idempotent per (run, action). recorded is false for a run that is not one of the learner\'s live readings.',
  expose: true,
  input: RecordNotificationFeedbackInput, output: RecordNotificationFeedbackOutput,
  func: async (services, data, { session }) => saveNotificationFeedback(metaDbQuery, await masteryLearnerFor(services, session), data),
})

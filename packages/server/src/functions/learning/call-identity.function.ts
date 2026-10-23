import { z } from 'zod'
import { CallIdentity, CallIdentityConfig, ClaimCallSpeakersInput, ClaimCallSpeakersOutput, ListCallsNeedingAttributionOutput, SaveCallIdentityOutput } from '@learner/contract'
import { CallAttributionError, claimCallSpeakers as claim, listCallsNeedingAttribution as listNeeding, loadCallIdentity, reattributeCalls, saveCallIdentity as save, type CallPipelineDeps } from '@learner/core/lib/learning/call-pipeline.js'
import { BadRequestError } from '@learner/core/runtime/errors.js'
import { defineFunction } from '../../runtime/define.js'

/**
 * Who the learner is on calls, and the calls a person must settle. Every change
 * re-derives the stored calls it touches, so lines recovered here are graded
 * without any source resending (call-pipeline.ts).
 */
type Services = { learnerDesktopHabits: () => CallPipelineDeps['habits']; config: { transcriptUploadRoot: string } }
const pipeline = ({ learnerDesktopHabits, config }: Services): CallPipelineDeps => ({ habits: learnerDesktopHabits(), uploadRoot: config.transcriptUploadRoot })

export const getCallIdentity = defineFunction({
  title: 'Get the learner\'s call identity',
  description: 'The speaker names and emails that mark the learner on a call.',
  expose: true, readonly: true,
  input: z.object({}), output: CallIdentityConfig,
  func: async () => loadCallIdentity(),
})

export const saveCallIdentity = defineFunction({
  title: 'Save the learner\'s call identity',
  description: 'Persist the names and emails, then re-attribute every stored call and grade any newly found learner lines.',
  expose: true, audit: true, scopes: ['admin'],
  input: CallIdentity, output: SaveCallIdentityOutput,
  func: async (services, input, { session }) => {
    const config = await save(input, session.userId)
    const { reattributed, spooled } = await reattributeCalls(pipeline(services))
    services.logger.info({ event: 'audit', action: 'learning.call-identity.saved', actorUserId: session.userId, names: config.names.length, emails: config.emails.length, reattributed, spooled })
    return { ...config, reattributed }
  },
})

export const listCallsNeedingAttribution = defineFunction({
  title: 'List calls whose learner lines need a person',
  description: 'Calls where the learner was present but no speaker is theirs by name: inferred ones to confirm, ambiguous ones to choose.',
  expose: true, readonly: true,
  input: z.object({}), output: ListCallsNeedingAttributionOutput,
  func: async () => ({ calls: await listNeeding() }),
})

export const claimCallSpeakers = defineFunction({
  title: 'Choose the learner\'s speakers on a call',
  description: 'Set which speaker labels are the learner on one call (none: the learner did not speak), optionally remembering the names for every call.',
  expose: true, audit: true, scopes: ['admin'],
  input: ClaimCallSpeakersInput, output: ClaimCallSpeakersOutput,
  func: async (services, input, { session }) => {
    try {
      const result = await claim(pipeline(services), input, session.userId)
      services.logger.info({ event: 'audit', action: 'learning.call-speakers.claimed', actorUserId: session.userId, ...input, ...result })
      return result
    } catch (e) {
      if (e instanceof CallAttributionError) throw new BadRequestError(e.message)
      throw e
    }
  },
})

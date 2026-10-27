import { z } from 'zod'
import { READAI_WEBHOOK_TEST_HEADER, ReadAiWebhookStatus, ReceiveReadAiWebhookOutput, SaveReadAiWebhookInput } from '@learner/contract'
import { clearReadAiWebhook as clear, loadReadAiWebhook, ReadAiWebhookRejected, receiveReadAiDelivery, saveReadAiWebhook as save } from '@learner/core/lib/learning/readai-webhook.js'
import type { CallPipelineDeps } from '@learner/core/lib/learning/call-pipeline.js'
import { BadRequestError, UnauthorizedError } from '@learner/core/runtime/errors.js'
import { defineFunction, defineSessionlessFunction } from '../../runtime/define.js'

/**
 * Settings > Integrations > Read AI webhook, and the public endpoint Read.ai
 * POSTs to (`POST /api/webhooks/readai/:token`, routes.ts). Every delivery
 * goes through the same call pipeline as the desktop and biztools uploads.
 */
type Services = { learnerDesktopHabits: () => CallPipelineDeps['habits']; config: { transcriptUploadRoot: string } }
const pipeline = ({ learnerDesktopHabits, config }: Services): CallPipelineDeps => ({ habits: learnerDesktopHabits(), uploadRoot: config.transcriptUploadRoot })

export const getReadAiWebhook = defineFunction({
  title: 'Get the Read AI webhook',
  description: 'Whether a webhook token is set (its last four characters only) and the last delivery that presented it.',
  expose: true, readonly: true,
  input: z.object({}), output: ReadAiWebhookStatus,
  func: async () => loadReadAiWebhook(),
})

export const saveReadAiWebhook = defineFunction({
  title: 'Set the Read AI webhook token',
  description: 'Store the sha256 of a new webhook token. The previous token stops working immediately.',
  expose: true, audit: true, scopes: ['admin'],
  input: SaveReadAiWebhookInput, output: ReadAiWebhookStatus,
  func: async ({ logger }, { token }, { session }) => {
    const status = await save(token, session.userId)
    logger.info({ event: 'audit', action: 'learning.readai-webhook.saved', actorUserId: session.userId, tokenHint: status.tokenHint })
    return status
  },
})

export const clearReadAiWebhook = defineFunction({
  title: 'Remove the Read AI webhook token',
  description: 'Delete the token; every delivery is refused until a new one is set.',
  expose: true, audit: true, scopes: ['admin'],
  input: z.object({}), output: ReadAiWebhookStatus,
  func: async ({ logger }, _input, { session }) => {
    const status = await clear()
    logger.info({ event: 'audit', action: 'learning.readai-webhook.cleared', actorUserId: session.userId })
    return status
  },
})

export const receiveReadAiWebhook = defineSessionlessFunction({
  title: 'Receive a Read AI meeting webhook',
  description: 'Verify the URL token, then store and grade the meeting through the call pipeline. A test delivery is verified and parsed, never stored.',
  // HTTP-only ingress for Read.ai; the URL token is the credential.
  expose: false, auth: false, readonly: false,
  input: z.record(z.string(), z.unknown()), output: ReceiveReadAiWebhookOutput,
  func: async (services, input, { http }) => {
    // The token comes from the path, never the merged body, so a payload field cannot stand in for it.
    const token = http?.request?.params().token ?? ''
    const test = http?.request?.header(READAI_WEBHOOK_TEST_HEADER) === '1'
    const { token: _token, ...body } = input
    try {
      const delivery = await receiveReadAiDelivery(pipeline(services as unknown as Services), token, body, test)
      services.logger.info({ event: 'readai-webhook-delivery', ...delivery })
      return { ok: true as const, test, sessionId: delivery.sessionId, outcome: delivery.outcome }
    } catch (error) {
      if (error instanceof ReadAiWebhookRejected) throw new UnauthorizedError('Unknown webhook token')
      if (error instanceof z.ZodError) throw new BadRequestError(`Not a Read.ai meeting payload: ${error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`)
      throw error
    }
  },
})

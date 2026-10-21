import { z } from 'zod'
import { defineSessionlessFunction } from '../../runtime/define.js'

export const TelemetryOutboxQueueInput = z.object({})
export const telemetryOutboxQueue = defineSessionlessFunction({
  title: 'Deliver durable telemetry outbox',
  input: TelemetryOutboxQueueInput,
  func: async ({ telemetryOutbox }) => telemetryOutbox.drain({ limit: 20 }),
})

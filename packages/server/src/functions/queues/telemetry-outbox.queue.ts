import { z } from 'zod'
import { pikkuSessionlessFunc } from '#pikku/function'

export const TelemetryOutboxQueueInput = z.object({})
export const telemetryOutboxQueue = pikkuSessionlessFunc({
  title: 'Deliver durable telemetry outbox',
  input: TelemetryOutboxQueueInput,
  func: async ({ telemetryOutbox }) => telemetryOutbox.drain({ limit: 20 }),
})

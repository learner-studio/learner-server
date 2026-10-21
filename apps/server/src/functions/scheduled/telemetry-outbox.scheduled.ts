import { defineVoidFunction } from '../../runtime/define.js'

export const scheduledTelemetryOutboxRecovery = defineVoidFunction({
  title: 'Recover pending telemetry and expired delivery leases',
  func: async ({ telemetryOutbox }) => {
    // Safety net for process/queue outages; producers and startup wake immediately.
    if (!await telemetryOutbox.wake()) throw new Error('Telemetry outbox queue unavailable')
  },
})

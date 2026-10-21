import type { QueueService } from '../../runtime/types.js'
import type { QueueCancellationService } from '../../runtime/types.js'
import { learningAdmissionPaused } from './learning-worker-runtime.js'
export const MAINTENANCE_ACTIONS = ['archive', 'exposure', 'index', 'traces', 'archive-admission', 'reactive'] as const
export type MaintenanceAction = typeof MAINTENANCE_ACTIONS[number]
export async function enqueueLearningMaintenance(
  queue: QueueService, lookup: QueueCancellationService,
  lock: { withLock<T>(site: string, type: string, callback: () => Promise<T>): Promise<T> },
  action: MaintenanceAction,
) {
  if (learningAdmissionPaused()) return
  await lock.withLock('learning-maintenance', action, async () => {
    const key = `learning-maintenance:${action}`
    const existing = await lookup.findByKey('learning.maintenance', key)
    if (existing.some(job => ['created', 'active', 'retry'].includes(job.state))) return
    await queue.add('learning.maintenance', { action }, { jobId: key, attempts: 3, backoff: { type: 'exponential', delay: 1000 } })
  })
}

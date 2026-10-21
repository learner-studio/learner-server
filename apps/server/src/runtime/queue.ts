import { PgBoss, type Job, type SendOptions, type WorkOptions } from 'pg-boss'
import type { QueueCancellationService, QueueJob, QueueJobOptions, QueueJobStatus, QueueService } from '@learner/core/runtime/index.js'

const toStatus = (state: string): QueueJobStatus =>
  state === 'active' ? 'active' : state === 'completed' ? 'completed' : state === 'failed' || state === 'cancelled' ? 'failed' : 'waiting'

/**
 * pg-boss behind the QueueService contract. Option mapping is the one the
 * Learning code was tuned against: `jobId` is the pg-boss singleton key,
 * `attempts` is total tries (retryLimit = attempts - 1), backoff delays are
 * milliseconds rounded UP to whole seconds, and an exponential backoff without
 * a delay gets a 1s base (pg-boss would otherwise retry immediately).
 */
export function toSendOptions(options: QueueJobOptions = {}): SendOptions {
  const out: SendOptions = {}
  if (options.priority !== undefined) out.priority = options.priority
  if (options.delay !== undefined) out.startAfter = new Date(Date.now() + options.delay)
  if (options.jobId !== undefined) out.singletonKey = options.jobId
  if (options.singletonKey !== undefined) out.singletonKey = options.singletonKey
  if (options.group !== undefined) out.group = { id: options.group.id, ...(options.group.tier !== undefined ? { tier: options.group.tier } : {}) }
  if (options.attempts !== undefined) out.retryLimit = options.attempts - 1
  if (options.backoff !== undefined) {
    out.retryBackoff = options.backoff.type === 'exponential'
    if (options.backoff.delay !== undefined) out.retryDelay = Math.max(1, Math.round(options.backoff.delay / 1000))
    else if (options.backoff.type === 'exponential') out.retryDelay = 1
  }
  if (options.expireInSeconds !== undefined) out.expireInSeconds = options.expireInSeconds
  return out
}

/** Worker configuration in the units the queue wirings were written in. */
export interface WorkerConfig {
  /** Parallel single-job pollers (pg-boss `localConcurrency`). */
  batchSize?: number
  prefetch?: number
  pollInterval?: number
  groupConcurrency?: number | { default: number; tiers?: Record<string, number> }
  [k: string]: unknown
}
export function toWorkOptions(config: WorkerConfig = {}): WorkOptions {
  const localConcurrency = config.batchSize ?? 10
  const out: WorkOptions = { localConcurrency, batchSize: 1 }
  if (config.pollInterval !== undefined) out.pollingIntervalSeconds = Math.max(0.5, Math.round(config.pollInterval / 1000))
  if (config.groupConcurrency !== undefined) {
    const clamp = (n: number) => Math.min(n, localConcurrency)
    out.localGroupConcurrency = typeof config.groupConcurrency === 'number' ? clamp(config.groupConcurrency)
      : { default: clamp(config.groupConcurrency.default), ...(config.groupConcurrency.tiers ? { tiers: Object.fromEntries(Object.entries(config.groupConcurrency.tiers).map(([t, n]) => [t, clamp(n)])) } : {}) }
  }
  return out
}

export class PgBossQueue implements QueueService, QueueCancellationService {
  private readonly created = new Set<string>()
  constructor(readonly boss: PgBoss) {}
  async ensureQueue(name: string, options: Parameters<PgBoss['createQueue']>[1] = {}) {
    if (this.created.has(name)) return
    await this.boss.createQueue(name, options)
    this.created.add(name)
  }
  async add(queue: string, data: unknown, options?: QueueJobOptions) {
    await this.ensureQueue(queue)
    const id = await this.boss.send(queue, (data ?? {}) as object, toSendOptions(options))
    if (!id) throw new Error('Failed to create job')
    return id
  }
  async getJob(queue: string, id: string): Promise<QueueJob | null> {
    const job = await this.boss.getJobById(queue, id)
    if (!job) return null
    const boss = this.boss
    return {
      queueName: queue, id: job.id, data: job.data,
      async status() { return toStatus((await boss.getJobById(queue, id))?.state ?? 'created') },
      async waitForCompletion(timeoutMs = 30_000) {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
          const current = await boss.getJobById(queue, id)
          if (current?.state === 'completed') return current.output
          if (current?.state === 'failed' || current?.state === 'cancelled') throw new Error(`Job failed: ${JSON.stringify(current.output)}`)
          await new Promise((r) => setTimeout(r, 100))
        }
        throw new Error('Job did not complete within timeout')
      },
    }
  }
  async findByKey(queue: string, key: string) {
    await this.ensureQueue(queue)
    return (await this.boss.findJobs(queue, { key }))
      .filter(({ state }) => !['completed', 'failed', 'cancelled'].includes(state))
      .map(({ id, state }) => ({ id, state }))
  }
  async cancelByKey(queue: string, key: string) {
    const jobs = await this.findByKey(queue, key)
    if (!jobs.length) return 0
    const result = await this.boss.cancel(queue, jobs.map((j) => j.id)) as { affected?: number } | undefined
    return result?.affected ?? jobs.length
  }
  async work(queue: string, config: WorkerConfig, handler: (job: Job<any>) => Promise<unknown>) {
    await this.ensureQueue(queue)
    return this.boss.work(queue, toWorkOptions(config), async ([job]) => handler(job!))
  }
}

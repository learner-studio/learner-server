import { wireQueueWorker } from '#pikku/queue'
import { workflowTimer } from '../workflow-timer.js'

// @pikku/queue-pg-boss 0.12.14 sends a sleep's wake-up on `pikku-mesh-rpc`. Until 0.12.10 it was
// `pikku-remote-internal-rpc`: a sleep scheduled just before the upgrade's restart still wakes from there, and
// recovery.ts reads a scheduled sleep as waiting, so without this worker that run would wait forever.
// Remove it once learner_pikku_boss.job holds no `pikku-remote-internal-rpc` job.
wireQueueWorker({ name: 'pikku-mesh-rpc', func: workflowTimer })
wireQueueWorker({ name: 'pikku-remote-internal-rpc', func: workflowTimer })

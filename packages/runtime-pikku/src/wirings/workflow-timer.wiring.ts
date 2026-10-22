import { wireQueueWorker } from '#pikku/queue'
import { workflowTimer } from '../workflow-timer.js'

wireQueueWorker({ name: 'pikku-remote-internal-rpc', func: workflowTimer })

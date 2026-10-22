import { pikkuConfig } from '#pikku/setup'
import { runtimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { loadConfig } from '@learner/server/config.js'

/** The shared Learner config for this process's role (set by the entry point). */
export const createConfig = pikkuConfig(async () => loadConfig(runtimeRole()))

import type { Logger } from '@learner/core/runtime/index.js'
const write = (level: string) => (message: unknown, ...rest: unknown[]) => {
  const line = typeof message === 'string' ? { level, message, ...(rest.length ? { detail: rest } : {}) } : { level, ...(message as object) }
  ;(level === 'error' ? console.error : console.log)(JSON.stringify(line))
}
export const createLogger = (): Logger => ({ info: write('info'), warn: write('warn'), error: write('error'), debug: process.env.LEARNER_DEBUG ? write('debug') : () => {} })

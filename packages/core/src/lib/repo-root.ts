import { resolve } from 'node:path'
/** The Learner checkout root (helper scripts under scripts/ resolve against it). */
export const repoRoot = resolve(import.meta.dir, '../../../..')

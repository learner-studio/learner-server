import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** The framework codegen's freshness: its stamp (written by generate.ts after a clean run) is newer than every
 * source it derives from. A process booted on stale codegen fails at runtime on whatever changed since. */
const ROOT = join(import.meta.dir, '..')
export const CODEGEN_STAMP = join(ROOT, '.pikku/.generated')
const INPUTS = ['src', '../server/src', '../core/src', '../contract/src', '../llm/src'].map((d) => join(ROOT, d))
const newest = (dir: string): number => readdirSync(dir).reduce((max, name) => {
  if (name === 'node_modules' || name === '.pikku') return max
  const path = join(dir, name)
  const stat = statSync(path)
  return Math.max(max, stat.isDirectory() ? newest(path) : stat.mtimeMs)
}, 0)
export const codegenFresh = () => existsSync(CODEGEN_STAMP) && statSync(CODEGEN_STAMP).mtimeMs > Math.max(...INPUTS.map(newest))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The workspace version (root package.json), reported to authenticated clients only. */
export const SERVER_VERSION: string = JSON.parse(readFileSync(join(import.meta.dir, '../../../package.json'), 'utf8')).version ?? '0.0.0'

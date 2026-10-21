import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { LearningFeedbackCatalog } from '@learner/contract'
import { z } from 'zod'
import { paths } from './config.js'

/**
 * The concept catalog, cached on disk by version.
 *
 * The previous hook compiled the catalog in; this one owns no Learning data,
 * so it keeps the last catalog the server sent. The control hook refreshes the
 * cache whenever a begin packet carries a catalog, and the catalog companions
 * (which run concurrently and never call the server on the hot path) read it.
 */
export type Catalog = z.infer<typeof LearningFeedbackCatalog>
const cachePath = () => `${paths.traceDir}/catalog.json`

export async function cachedCatalog(): Promise<Catalog | null> {
  return readFile(cachePath(), 'utf8').then((text) => LearningFeedbackCatalog.parse(JSON.parse(text))).catch(() => null)
}

export async function storeCatalog(catalog: Catalog) {
  await mkdir(paths.traceDir, { recursive: true, mode: 0o700 })
  // Write-then-rename: a concurrent companion reads either the old or the new file, never half of one.
  const tmp = `${cachePath()}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(catalog), { mode: 0o600 })
  await rename(tmp, cachePath())
}

import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { isAbsolute } from 'node:path'
import { DEFAULT_SQLITE_STAGING_ROOT, resolveSqliteStagingRoot } from './learning-lossless-archive-sync-service.js'

// Whole SQLite files (hundreds of MB) are staged here and held across passes.
// On 2026-09-21 the default was `os.tmpdir()`, which is a RAM-backed tmpfs on
// the dev box: ~1 GB of RAM per pass, then `disk-pressure` failures once /tmp
// was capped at 2G. The default must be a disk path, never tmpdir-derived.
describe('sqlite staging root', () => {
  test('defaults to an absolute disk path outside os.tmpdir()', () => {
    const root = resolveSqliteStagingRoot(undefined)
    expect(root).toBe(DEFAULT_SQLITE_STAGING_ROOT)
    expect(isAbsolute(root)).toBe(true)
    expect(root.startsWith(`${tmpdir()}/`)).toBe(false)
    expect(root.startsWith('/var/tmp/')).toBe(true)
  })

  test('an explicitly configured root wins', () => {
    expect(resolveSqliteStagingRoot('/srv/staging')).toBe('/srv/staging')
  })
})

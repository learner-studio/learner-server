import { describe, expect, test } from 'bun:test'
import { isAbsolute } from 'node:path'
import { DEFAULT_SQLITE_STAGING_ROOT, resolveSqliteStagingRoot } from './learning-lossless-archive-sync-service.js'

// Whole SQLite files (hundreds of MB) are staged here and held across passes.
// On 2026-09-21 the default was `os.tmpdir()`, which is a RAM-backed tmpfs on
// the dev box: ~1 GB of RAM per pass, then `disk-pressure` failures once /tmp
// was capped at 2G. The default must be a disk path, never tmpdir-derived. The
// assertion names /tmp itself, not os.tmpdir(), which follows TMPDIR and may
// legitimately BE /var/tmp.
describe('sqlite staging root', () => {
  test('defaults to an absolute disk path outside the /tmp tmpfs', () => {
    const root = resolveSqliteStagingRoot(undefined)
    expect(root).toBe(DEFAULT_SQLITE_STAGING_ROOT)
    expect(isAbsolute(root)).toBe(true)
    expect(root.startsWith('/tmp/')).toBe(false)
    expect(root.startsWith('/var/tmp/')).toBe(true)
  })

  test('an explicitly configured root wins', () => {
    expect(resolveSqliteStagingRoot('/srv/staging')).toBe('/srv/staging')
  })
})

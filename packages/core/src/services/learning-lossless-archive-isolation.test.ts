import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'

import type { DB } from '../types/db.types.js'
import { LearningLosslessArchiveService } from './learning-lossless-archive-service.js'

const privilegeTest = process.env.LOSSLESS_ARCHIVE_RUN_PRIVILEGE_TESTS === '1' ? test : test.skip

describe('lossless archive isolation boundaries', () => {
  test('fails closed when PostgreSQL is unavailable', async () => {
    const kysely = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: new Pool({
          connectionString: 'postgresql://lossless:unusable@127.0.0.1:1/lossless_unavailable',
          connectionTimeoutMillis: 250,
          max: 1,
        }),
      }),
      plugins: [new CamelCasePlugin()],
    })
    try {
      await expect(new LearningLosslessArchiveService(kysely).getRun('00000000-0000-4000-8000-000000000001'))
        .rejects.toThrow()
    } finally {
      await kysely.destroy()
    }
  })

  test('captures raw bytes in a credential-free subprocess with network fetch trapped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lossless-no-provider-'))
    const path = join(root, 'opaque.bin')
    const bytes = Buffer.concat([Buffer.from('opaque\r\n'), Buffer.from([0xff, 0x00, 0x80])])
    await writeFile(path, bytes, { mode: 0o600 })
    const environment = { ...process.env }
    for (const key of [
      'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
      'AGY_API_KEY', 'CODEX_API_KEY', 'HINDSIGHT_API_KEY', 'HINDSIGHT_BASE_URL',
    ]) delete environment[key]
    const script = String.raw`
      import { captureOpaqueFile } from './packages/core/src/lib/learning/lossless-archive-files.ts'
      import { createHash } from 'node:crypto'
      let fetchCalls = 0
      globalThis.fetch = async () => { fetchCalls += 1; throw new Error('network fetch forbidden during raw capture') }
      const captured = await captureOpaqueFile(process.argv[1], { approvedRoot: process.argv[2] })
      const credentialsPresent = ['OPENAI_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','AGY_API_KEY','CODEX_API_KEY','HINDSIGHT_API_KEY']
        .filter((key) => Boolean(process.env[key]))
      process.stdout.write(JSON.stringify({ rawLength: captured.rawLength, rawSha256: captured.rawSha256, fetchCalls, credentialsPresent }))
    `
    try {
      const child = Bun.spawn(['bun', '-e', script, path, root], {
        cwd: process.cwd(), env: environment, stdout: 'pipe', stderr: 'pipe',
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      expect(exitCode, stderr).toBe(0)
      const result = JSON.parse(stdout) as { rawLength: number; rawSha256: string; fetchCalls: number; credentialsPresent: string[] }
      expect(result).toEqual({
        rawLength: bytes.length,
        rawSha256: createHash('sha256').update(bytes).digest('hex'),
        fetchCalls: 0,
        credentialsPresent: [],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  privilegeTest('refuses a real unreadable file when capture runs as nobody', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lossless-unreadable-'))
    const path = join(root, 'root-only.bin')
    const helperPath = join(root, 'lossless-archive-files.ts')
    await chmod(root, 0o755)
    await writeFile(path, Buffer.from('must-not-be-readable'), { mode: 0o600 })
    await copyFile(join(process.cwd(), 'packages/core/src/lib/learning/lossless-archive-files.ts'), helperPath)
    await chmod(helperPath, 0o644)
    const script = String.raw`
      import { captureOpaqueFile } from ${JSON.stringify(helperPath)}
      await captureOpaqueFile(process.argv[1], { approvedRoot: process.argv[2] })
    `
    try {
      const child = Bun.spawn([
        '/usr/bin/sudo', '-n', '-u', 'nobody', '--', 'bun', '-e', script, path, root,
      ], { cwd: root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' })
      const [exitCode, stderr] = await Promise.all([
        child.exited, new Response(child.stderr).text(),
      ])
      expect(exitCode).not.toBe(0)
      expect(stderr).toMatch(/EACCES|permission denied/i)
      expect(stderr).not.toMatch(/ENOENT|no such file/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

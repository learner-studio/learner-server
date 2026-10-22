import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { selectedRuntime } from '../scripts/runtime.ts'

const installed = readdirSync(join(import.meta.dir, '../packages')).filter((d) => d.startsWith('runtime-')).map((d) => d.slice('runtime-'.length))

describe('runtime selection', () => {
  test('LEARNER_RUNTIME wins', () => {
    expect(selectedRuntime({ LEARNER_RUNTIME: 'standalone' })).toBe('standalone')
  })
  test('unset, it is the adapter when installed, else standalone', () => {
    const adapter = installed.find((r) => r !== 'standalone')
    expect(selectedRuntime({})).toBe(adapter ?? 'standalone')
  })
})

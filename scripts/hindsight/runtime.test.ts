import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// Every transient Hindsight experiment runtime must be bounded in memory and
// in lifetime: `systemd-run --collect` never collects a server, so each start
// schedules its own reaper. These tests read the launchers' dry-run output (the
// exact systemd commands they would issue), so nothing touches systemd.

const launchers = [
  { name: 'seed-v1', script: 'seed-v1-runtime.sh', args: ['probe-run', '18931', 'extractor'], unit: 'learner-hindsight-probe-run.service' },
  { name: 'agy', script: 'agy-runtime.sh', args: ['probe-run', '18932'], unit: 'learner-hindsight-hindsight-agy-probe-run.service' },
] as const

const dryRun = (script: string, action: string, args: readonly string[], env: Record<string, string> = {}) =>
  execFileSync('bash', [join(import.meta.dirname, script), action, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HINDSIGHT_RUNTIME_DRY_RUN: '1', ...env },
  }).trim().split('\n')

for (const launcher of launchers) {
  describe(`${launcher.name} launcher`, () => {
    const serverLine = (lines: string[]) => lines.find((line) => line.startsWith(`systemd-run --quiet --unit=${launcher.unit} `))
    const reaperUnit = launcher.unit.replace(/\.service$/, '-reaper')

    test('bounds the server unit: MemoryMax, no paging, enough tasks', () => {
      const server = serverLine(dryRun(launcher.script, 'start', launcher.args))
      expect(server).toBeDefined()
      expect(server).toMatch(/--property=MemoryMax=4G /)
      expect(server).toMatch(/--property=MemorySwapMax=0 /)
      expect(server).toMatch(/--property=TasksMax=512 /)
      expect(server).toMatch(/--collect /)
    })

    test('schedules a reaper that stops the server after the lifetime', () => {
      const lines = dryRun(launcher.script, 'start', launcher.args)
      const reaper = lines.find((line) => line.startsWith(`systemd-run --quiet --unit=${reaperUnit} `))
      expect(reaper).toBeDefined()
      expect(reaper).toMatch(/--on-active=43200 /)
      expect(reaper!.endsWith(`systemctl stop ${launcher.unit}`)).toBe(true)
      // A restart of the same run replaces the previous reaper so the lifetime counts from now.
      const serverIndex = lines.indexOf(serverLine(lines)!)
      const stopOld = lines.indexOf(`systemctl stop ${reaperUnit}.timer`)
      expect(stopOld).toBeGreaterThan(serverIndex)
      expect(lines.indexOf(reaper!)).toBeGreaterThan(stopOld)
    })

    test('honours HINDSIGHT_RUNTIME_MAX_SEC and rejects a zero lifetime', () => {
      expect(dryRun(launcher.script, 'start', launcher.args, { HINDSIGHT_RUNTIME_MAX_SEC: '600' }).some((line) => /--on-active=600 /.test(line))).toBe(true)
      expect(() => dryRun(launcher.script, 'start', launcher.args, { HINDSIGHT_RUNTIME_MAX_SEC: '0' })).toThrow()
    })

    test('stop also cancels the reaper', () => {
      expect(dryRun(launcher.script, 'stop', launcher.args)).toEqual([`systemctl stop ${reaperUnit}.timer`, `systemctl stop ${launcher.unit}`])
    })

    test('state root and install root are overridable', () => {
      const server = serverLine(dryRun(launcher.script, 'start', launcher.args, { LEARNER_HINDSIGHT_STATE_ROOT: '/srv/hs', HINDSIGHT_INSTALL_ROOT: '/opt/hs' }))
      expect(server).toContain('WorkingDirectory=/srv/hs/')
      expect(server).toContain('/opt/hs')
    })
  })
}

test('agy launcher routes the model bridge to Learner with the agent key file', () => {
  const server = dryRun('agy-runtime.sh', 'start', ['probe-run', '18932']).find((line) => line.includes('--unit=learner-hindsight-hindsight-agy-probe-run.service'))!
  expect(server).toContain('--property=EnvironmentFile=/etc/learner/agent-key.env')
  expect(server).toContain('--setenv=BT_BRIDGE_URL=http://127.0.0.1:3010/api/internal/hindsight/v1')
  expect(dryRun('agy-runtime.sh', 'start', ['probe-run', '18932'], { LEARNER_URL: 'http://127.0.0.1:4000' }).join('\n')).toContain('BT_BRIDGE_URL=http://127.0.0.1:4000/')
})

test('launchers refuse the canonical archive port', () => {
  expect(() => dryRun('seed-v1-runtime.sh', 'start', ['probe-run', '18925'])).toThrow()
  expect(() => dryRun('agy-runtime.sh', 'start', ['probe-run', '18923'])).toThrow()
})

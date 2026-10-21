import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Installed Claude + mock HTTP model: witness the request, not an echoed fixture.
 * No credentials, real model traffic, user config, MCP servers, or tools.
 */
export async function probeClaudeHookDelivery(contexts: string[], options: { realModel?: boolean; prompt?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'learning-hook-delivery-'))
  const captured: string[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname.includes('/messages')) {
      const body = await request.json() as { messages?: unknown }
      captured.push(JSON.stringify(body.messages))
      return Response.json({ id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'MOCK_RESPONSE' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
    }
    return Response.json({})
  } })
  try {
    const hooks = []
    for (const [index, context] of contexts.entries()) {
      const path = join(dir, `hook-${index}.json`)
      await writeFile(path, JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }))
      hooks.push({ type: 'command', command: `/usr/bin/bun -e 'process.stdout.write(await Bun.file(${JSON.stringify(path)}).text())'`, timeout: 5 })
    }
    const settings = join(dir, 'settings.json')
    await writeFile(settings, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks }] } }))
    const child = Bun.spawn(['/usr/bin/claude', '-p', options.prompt ?? 'Test Learning context delivery.', '--setting-sources', '', '--settings', settings, '--strict-mcp-config', '--tools', '', '--no-session-persistence', '--system-prompt', 'Transport probe. Return only what the user requests.', '--model', 'sonnet'], {
      cwd: dir, env: options.realModel ? { ...process.env, CLAUDECODE: undefined } : { PATH: '/usr/bin:/bin', HOME: dir, CLAUDE_CONFIG_DIR: dir, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_API_KEY: 'mock-local-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const timer = setTimeout(() => child.kill(), options.realModel ? 90000 : 30000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0 || (!options.realModel && !captured.length)) throw new Error(`Claude delivery probe failed (${code}): ${stderr.slice(0,1000)} ${stdout.slice(0,300)}`)
      return { request: captured.at(-1) ?? '', requests: captured.length, stdout, paidCalls: options.realModel ? 1 : 0 }
    } finally { clearTimeout(timer) }
  } finally {
    server.stop(true)
    // Only this probe's mkdtemp-owned synthetic fixture directory is removed.
    await rm(dir, { recursive: true, force: true })
  }
}

import { describe, expect, test } from 'bun:test'
import { createCurriculumJsonReader, createCurriculumPageReader } from './curriculum-page-reader.js'

const reader = (mode: 'cloudflare' | 'local', calls: string[]) => createCurriculumPageReader({
  mode,
  renderCloudflareMarkdown: async (url) => { calls.push(`cloudflare:${url}`); return 'cloudflare body' },
  renderLocalMarkdown: async (url) => { calls.push(`local:${url}`); return 'local body' },
})

describe('the curriculum page reader honours the crawler infrastructure mode', () => {
  test('local mode makes no Cloudflare call at all', async () => {
    // The standing rule is that local means ZERO Cloudflare calls, not
    // Cloudflare with a fallback. Asserting on the call log rather than on the
    // returned body is the point: a fallback would still return local text.
    const calls: string[] = []
    const result = await reader('local', calls)('https://ocw.mit.edu/courses/6-006/')
    expect(calls).toEqual(['local:https://ocw.mit.edu/courses/6-006/'])
    expect(calls.some((call) => call.startsWith('cloudflare:'))).toBe(false)
    expect(result.body).toBe('local body')
  })

  test('cloudflare mode reads through Cloudflare and never touches the local tier', async () => {
    const calls: string[] = []
    await reader('cloudflare', calls)('https://ocw.mit.edu/courses/6-006/')
    expect(calls).toEqual(['cloudflare:https://ocw.mit.edu/courses/6-006/'])
  })

  test('an empty body is not a success, so nothing can be grounded in a blank page', async () => {
    const read = createCurriculumPageReader({
      mode: 'cloudflare',
      renderCloudflareMarkdown: async () => '   \n  ',
      renderLocalMarkdown: async () => 'unused',
    })
    expect((await read('https://x.test/')).ok).toBe(false)
  })

  test('a renderer that throws becomes a failed read, not a thrown run', async () => {
    // One unreachable provider page must not fail the whole run: the sourcing
    // step walks candidates in order and moves to the next.
    const read = createCurriculumPageReader({
      mode: 'cloudflare',
      renderCloudflareMarkdown: async () => { throw new Error('render timeout') },
      renderLocalMarkdown: async () => 'unused',
    })
    const result = await read('https://x.test/')
    expect(result).toEqual({ ok: false, status: 0, body: '' })
  })
})

describe('the JSON reader talks to provider APIs directly', () => {
  test('it returns the body and status without a renderer', async () => {
    const read = createCurriculumJsonReader(async () => ({ ok: true, status: 200, text: async () => '{"results":[]}' }))
    expect(await read('https://api.learn.mit.edu/x')).toEqual({ ok: true, status: 200, body: '{"results":[]}' })
  })

  test('a non-200 is reported rather than thrown', async () => {
    const read = createCurriculumJsonReader(async () => ({ ok: false, status: 503, text: async () => 'nope' }))
    expect(await read('https://api.learn.mit.edu/x')).toMatchObject({ ok: false, status: 503 })
  })

  test('a network failure is a failed read', async () => {
    const read = createCurriculumJsonReader(async () => { throw new Error('ECONNREFUSED') })
    expect(await read('https://api.learn.mit.edu/x')).toEqual({ ok: false, status: 0, body: '' })
  })
})

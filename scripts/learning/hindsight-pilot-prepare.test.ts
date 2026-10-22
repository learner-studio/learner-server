import { describe, expect, test } from 'bun:test'
import { preparePilot } from './hindsight-pilot-prepare.js'

const sha = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex')
const message = (id: string, text: string) => ({ id, logicalMessageKey: `key:${id}`, observedAt: '2026-09-05T00:00:00.000Z', rawVersionId: crypto.randomUUID(), text, textSha256: sha(text), media: [] })
const manifest = () => ({ schemaVersion: 1, label: 'pilot', cutoff: '2026-09-05T00:00:00.000Z', pairCount: 3, messageCount: 6,
  membershipDigest: 'a'.repeat(64), sourceCompleteness: {}, selection: {}, cases: [1, 2, 3].map(ordinal => ({ caseId: `case-${ordinal}`, ordinal,
    exchangeId: `exchange-${ordinal}`, current: message(`human-${ordinal}`, `human ${ordinal}`), response: message(`agent-${ordinal}`, `agent ${ordinal}`) })) })

describe('Hindsight AGY pilot preparation', () => {
  test('freezes current classifier and gradual-assessment contracts without changing membership', () => {
    const input = manifest()
    const output = preparePilot(input, '11111111-1111-4111-8111-111111111111')
    expect(output.membershipDigest).toBe(input.membershipDigest)
    expect(output.cases.map(item => item.caseId)).toEqual(input.cases.map(item => item.caseId))
    expect(output.conceptCatalog.length).toBeGreaterThan(400)
    expect(output.nodeStates).toHaveLength(output.conceptCatalog.length)
    expect(output.contracts.reflectResponseSchemaSentToHindsight).toBe(false)
    expect(output.contracts.innerAssessmentValidation).toContain('no-repair')
  })

  test('rejects mutated source text', () => {
    const input = manifest()
    input.cases[0]!.current.text = 'changed'
    expect(() => preparePilot(input, crypto.randomUUID())).toThrow(/hash mismatch/)
  })
})

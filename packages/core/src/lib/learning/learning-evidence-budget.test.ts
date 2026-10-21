import {describe,test,expect} from 'bun:test'
import {trimEvidenceNewestFirst,estimateEvidenceTokens} from './learning-evidence-budget.js'

const item=(id:string,occurredAt:string|null,text:string,role='user')=>({id,conversationId:'c',role,text,occurredAt})
const evidence=[
  item('a','2026-09-01T00:00:00.000Z','x'.repeat(300)),
  item('b','2026-09-03T00:00:00.000Z','y'.repeat(300),'assistant'),
  item('c','2026-09-02T00:00:00.000Z','z'.repeat(300)),
]

describe('newest-first evidence budget',()=>{
  test('cuts the oldest whole items first and returns survivors in original order',()=>{
    const one=estimateEvidenceTokens([evidence[0]!],3)
    const result=trimEvidenceNewestFirst(evidence,{maxTokens:one*2,charsPerToken:3})
    expect(result.kept.map(e=>e.id)).toEqual(['b','c'])
    expect(result.droppedIds).toEqual(['a'])
    expect(result.estimatedTokens).toBeLessThanOrEqual(one*2)
    expect(result.rule).toBe('newest-first-whole-items-v1')
  })
  test('keeps everything when it fits and never splits a message',()=>{
    const all=trimEvidenceNewestFirst(evidence,{maxTokens:10_000,charsPerToken:3})
    expect(all.kept).toEqual(evidence)
    expect(all.droppedIds).toEqual([])
    const none=trimEvidenceNewestFirst(evidence,{maxTokens:10,charsPerToken:3})
    expect(none.kept).toEqual([])
    for(const kept of trimEvidenceNewestFirst(evidence,{maxTokens:150,charsPerToken:3}).kept)expect(evidence).toContainEqual(kept)
  })
  test('stops at the first item that does not fit instead of skipping ahead to smaller older items',()=>{
    const mixed=[item('old-small','2026-09-01T00:00:00.000Z','s'),item('mid-big','2026-09-02T00:00:00.000Z','b'.repeat(3000)),item('new','2026-09-03T00:00:00.000Z','n'.repeat(30))]
    const result=trimEvidenceNewestFirst(mixed,{maxTokens:estimateEvidenceTokens([mixed[2]!,mixed[0]!],3),charsPerToken:3})
    expect(result.kept.map(e=>e.id)).toEqual(['new'])
  })
  test('ties and missing timestamps order deterministically, undated items counting as oldest',()=>{
    const tied=[item('b','2026-09-01T00:00:00.000Z','1'),item('a','2026-09-01T00:00:00.000Z','2'),item('u',null,'3')]
    const cap=estimateEvidenceTokens([tied[0]!],3)*2
    expect(trimEvidenceNewestFirst(tied,{maxTokens:cap,charsPerToken:3}).kept.map(e=>e.id)).toEqual(['b','a'])
    expect(trimEvidenceNewestFirst([...tied].reverse(),{maxTokens:cap,charsPerToken:3}).kept.map(e=>e.id)).toEqual(['a','b'])
  })
  test('rejects nonsensical budgets',()=>{
    expect(()=>trimEvidenceNewestFirst(evidence,{maxTokens:0,charsPerToken:3})).toThrow()
    expect(()=>trimEvidenceNewestFirst(evidence,{maxTokens:100,charsPerToken:0})).toThrow()
  })
})

import { describe,expect,test } from 'bun:test'
import { taskTeachingContext,TASK_TEACHING_DEFAULT } from './learning-teaching-default.js'
import { prerequisitePolicy } from './learning-prerequisite-selection.js'
import { DEFAULT_LEARNING_POLICY } from '@learner/contract/learning/learning-policy.js'
const base={ids:['css'],catalog:[{id:'css',title:'CSS box model'}],assessments:[],suppressed:new Set<string>(),gaps:[],edges:[],foundationFirst:true,prerequisites:prerequisitePolicy(DEFAULT_LEARNING_POLICY)}
test('unassessed concepts remain eligible without vector retrieval',()=>{
  const packet=taskTeachingContext(base)
  expect(packet.conceptIds).toEqual(['css'])
  expect(packet.context).toContain('"understandingPercent":null')
  expect(packet.context).toContain('demonstrated skillfulness')
  expect(packet.context).toContain('assume a complete beginner')
})
test('catalog gaps do not prohibit task-connected teaching',()=>{
  expect(taskTeachingContext({...base,ids:[]}).context).toContain('actual task')
  expect(TASK_TEACHING_DEFAULT).toContain('must not prevent teaching')
})
test('v1.4 expands foundations while preserving a task anchor even if legacy toggle is false',()=>{
  const packet=taskTeachingContext({...base,ids:['c','b','a','d'],catalog:['a','b','c','d'].map(id=>({id,title:id})),foundationFirst:false,edges:[{from:'a',to:'b',kind:'hard-prerequisite'},{from:'b',to:'c',kind:'hard-prerequisite'}],prerequisites:{...base.prerequisites,count:1}})
  expect(packet.conceptIds).toEqual(['a','c','b','d'])
  expect(packet.context).toContain('LEARNING TEACHING POLICY v1.4')
  expect(packet.context).toContain('why the mechanism works')
  expect(packet.context).toContain('With no demonstration')
  expect(packet.context).toContain('at most one')
})
test('foundation guidance stays relevant and does not manufacture weakness or require checks on every turn',()=>{
  for(const text of ['weakest evidenced prerequisite','Unknown is not zero mastery','unobserved, not a demonstrated gap','Do not detour','because X, we do Y','silence is not failure','Skip checks on approvals']) expect(TASK_TEACHING_DEFAULT).toContain(text)
})
test('demonstrations suppress repeats while partial evidence narrows the target',()=>{
  expect(taskTeachingContext({...base,suppressed:new Set(['css'])}).conceptIds).toEqual([])
  const packet=taskTeachingContext({...base,suppressed:new Set(['css']),gaps:[{conceptId:'css',remainingGap:'Margin versus padding'}]})
  expect(packet.conceptIds).toEqual(['css'])
  expect(packet.context).toContain('Margin versus padding')
})
test('escaped gap content cannot exceed the structured guidance ceiling',()=>{
  const packet=taskTeachingContext({...base,gaps:[{conceptId:'css',remainingGap:'\u0000'.repeat(500)}]})
  expect(packet.context.length).toBeLessThanOrEqual(4000)
  expect(packet.conceptIds).toEqual([])
})

describe('spaced-repetition review slot',()=>{
  const now=new Date('2026-10-23T00:00:00Z')
  const daysAgo=(days:number)=>new Date(now.getTime()-days*86_400_000)
  const pre=(from:string,to:string)=>({from,to,kind:'hard-prerequisite'})
  const rel=(from:string,to:string)=>({from,to,kind:'related'})
  const ready=(conceptId:string,understandingPercent:number)=>({conceptId,status:'ready' as const,assessment:{understandingPercent,confidence:'medium'} as never,assessedAt:null,runId:'r'})
  const ids=['p1','p2','p3','p4','p5','task','task2','near','far','solo']
  const sr=(exposures:Record<string,number>,hops=1,offered:string[]=[])=>({hops,now,history:{exposures:new Map(Object.entries(exposures).map(([id,d])=>[id,daysAgo(d)])),offered:new Set(offered)}})
  const input={...base,ids:['task'],catalog:ids.map(id=>({id,title:id})),edges:[...['p1','p2','p3','p4','p5'].map(p=>pre(p,'task')),rel('task','near'),rel('near','far')],
    assessments:['p1','p2','p3','p4','p5'].map(id=>ready(id,10)),prerequisites:{strictness:100,count:5,depth:'all' as const}}
  test('off: no spaced-repetition section and the packet is unchanged',()=>{
    const off=taskTeachingContext(input)
    expect(taskTeachingContext({...input,spacedRepetition:null})).toEqual(off)
    expect(off.context).not.toContain('Spaced repetition')
    expect(off.reviewConceptId).toBeNull()
  })
  test('a due related review takes a slot after the anchor; prerequisites keep 5 - anchor - review',()=>{
    const packet=taskTeachingContext({...input,spacedRepetition:sr({near:5})})
    expect(packet.conceptIds).toEqual(['p1','p2','p3','task','near'])
    expect(packet.reviewConceptId).toBe('near')
    expect(packet.context).toContain('"role":"review"')
    expect(packet.context).toContain('"relatedTo":"task"')
    expect(packet.context).toContain('"intervalDays":3')
    expect(packet.context).toContain('Spaced repetition: {"hops":1,"due":1,"related":1,"selected":"near"}')
  })
  test('hop setting gates relevance; not due means no review',()=>{
    expect(taskTeachingContext({...input,spacedRepetition:sr({far:5})}).reviewConceptId).toBeNull()
    expect(taskTeachingContext({...input,spacedRepetition:sr({far:5},2)}).reviewConceptId).toBe('far')
    expect(taskTeachingContext({...input,spacedRepetition:sr({near:1})}).reviewConceptId).toBeNull()
  })
  test('a review that is already a selected prerequisite is delivered once; the next due one is used',()=>{
    const packet=taskTeachingContext({...input,spacedRepetition:sr({p1:30,near:5})})
    expect(packet.conceptIds).toEqual(['p1','p2','p3','task','near'])
    expect(packet.reviewConceptId).toBe('near')
  })
  test('a selected prerequisite that loses its slot to the review can still be the review',()=>{
    const packet=taskTeachingContext({...input,spacedRepetition:sr({p4:30,near:5})})
    expect(packet.conceptIds).toEqual(['p1','p2','p3','task','p4'])
    expect(packet.reviewConceptId).toBe('p4')
    expect(packet.context).toContain('"conceptId":"p4","title":"p4","understandingPercent":10,"remainingGap":null,"role":"review"')
  })
  test('a review alone gives a turn something to teach when the task is suppressed',()=>{
    const packet=taskTeachingContext({...input,assessments:[],edges:[rel('task','near')],suppressed:new Set(['task']),spacedRepetition:sr({near:5})})
    expect(packet.conceptIds).toEqual(['near'])
  })
  test('offered reviews and suppressed concepts are skipped',()=>{
    expect(taskTeachingContext({...input,spacedRepetition:sr({near:5},1,['near'])}).reviewConceptId).toBeNull()
    expect(taskTeachingContext({...input,suppressed:new Set(['near']),spacedRepetition:sr({near:5})}).reviewConceptId).toBeNull()
  })
  test('the 4000-char ceiling trims other task concepts, then the review, before prerequisites',()=>{
    const gap='g'.repeat(500)
    const roomy=taskTeachingContext({...input,ids:['task','task2'],spacedRepetition:sr({near:5})})
    expect(roomy.conceptIds).toEqual(['p1','p2','p3','task','near'])
    const packet=taskTeachingContext({...input,ids:['task','task2'],suppressed:new Set(['p1']),gaps:[{conceptId:'p1',remainingGap:gap}],spacedRepetition:sr({near:5})})
    expect(packet.context.length).toBeLessThanOrEqual(4000)
    expect(packet.conceptIds).toEqual(['p1','p2','p3','task'])
    expect(packet.reviewConceptId).toBeNull()
    expect(packet.context).toContain('"selected":null')
  })
})

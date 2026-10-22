import {test,expect,describe} from 'bun:test'
import {selectPrerequisites,type PrerequisitePolicy} from './learning-prerequisite-selection.js'
import {taskTeachingContext} from './learning-teaching-default.js'
import {LearningConceptAssessmentSchema} from './learning-concept-assessment-schemas.js'
const edge=(from:string,to:string)=>({from,to,kind:'hard-prerequisite'})
// root -> mid -> task, peer -> task: mid and peer are 1 hop, root is 2 hops.
const base={targets:['task'],catalogIds:['root','mid','peer','task','unrelated'],edges:[edge('root','mid'),edge('mid','task'),edge('peer','task')],scores:new Map([['root',10],['mid',10],['peer',10],['unrelated',0]]),suppressed:new Set<string>()}
const policy=(overrides:Partial<PrerequisitePolicy>={}):PrerequisitePolicy=>({strictness:100,count:5,depth:'all',...overrides})
const ids=(result:ReturnType<typeof selectPrerequisites>)=>result.foundations.map(f=>f.conceptId)

describe('prerequisite count',()=>{
  test('foundations of a tie come first: an independent branch beats a dependent of a selected root',()=>{
    expect(ids(selectPrerequisites(base,policy({count:2})))).toEqual(['peer','root'])
  })
  test('each extra slot takes the next layer, never more than the count',()=>{
    for(const count of [1,2,3,4,5]) expect(ids(selectPrerequisites(base,policy({count})))).toEqual(['peer','root','mid'].slice(0,count))
  })
  test('lowest percentage precedes hierarchy',()=>{
    expect(ids(selectPrerequisites({...base,scores:new Map([['root',50],['mid',5],['peer',20]])},policy({count:2})))).toEqual(['mid','peer'])
  })
})

describe('prerequisite fallback depth',()=>{
  test('depth 1 sees only direct prerequisites; depth 2 and all reach the root',()=>{
    expect(ids(selectPrerequisites(base,policy({depth:1})))).toEqual(['mid','peer'])
    expect(ids(selectPrerequisites(base,policy({depth:2})))).toEqual(['peer','root','mid'])
    expect(ids(selectPrerequisites(base,policy({depth:'all'})))).toEqual(['peer','root','mid'])
  })
  test('a five-deep chain: each depth step adds exactly one ancestor, and all reaches past five',()=>{
    const chain=['c6','c5','c4','c3','c2','c1','task']
    const input={...base,catalogIds:chain,edges:chain.slice(0,-1).map((id,i)=>edge(id,chain[i+1]!)),scores:new Map(chain.slice(0,-1).map(id=>[id,10]))}
    for(const depth of [1,2,3,4,5] as const) expect(selectPrerequisites(input,policy({depth})).candidates).toBe(depth)
    expect(selectPrerequisites(input,policy({depth:'all'})).candidates).toBe(6)
    expect(ids(selectPrerequisites(input,policy({depth:3,count:1})))).toEqual(['c3'])
  })
  test('a concept reachable at several depths counts at its nearest one',()=>{
    const input={...base,edges:[...base.edges,edge('root','task')]}
    expect(ids(selectPrerequisites(input,policy({depth:1})))).toEqual(['peer','root','mid'])
  })
})

describe('prerequisite strictness decides what is unmet',()=>{
  const scores=new Map([['root',70],['mid',50],['peer',90]])
  test('a prerequisite at or above the strictness bar is met',()=>{
    expect(ids(selectPrerequisites({...base,scores},policy({strictness:60})))).toEqual(['mid'])
    expect(ids(selectPrerequisites({...base,scores},policy({strictness:80})))).toEqual(['mid','root'])
    expect(ids(selectPrerequisites({...base,scores},policy({strictness:100})))).toEqual(['mid','root','peer'])
  })
  test('strictness 0 turns fallback off',()=>{
    const off=selectPrerequisites({...base,scores:new Map()},policy({strictness:0}))
    expect(off.mode).toBe('off')
    expect(off.foundations).toEqual([])
  })
  test('unknown is not zero: unscored prerequisites are offered only when nothing scored is unmet',()=>{
    const unknown=selectPrerequisites({...base,scores:new Map()},policy({count:2}))
    expect(unknown.mode).toBe('unknown')
    expect(ids(unknown)).toEqual(['peer','root'])
    expect(unknown.foundations.every(f=>f.understandingPercent===null)).toBe(true)
    expect(ids(selectPrerequisites({...base,scores:new Map([['mid',30]])},policy()))).toEqual(['mid'])
    expect(selectPrerequisites({...base,scores:new Map([['root',100],['mid',100],['peer',100]])},policy()).foundations).toEqual([])
  })
})

test('ignores soft edges and invalid IDs; cycles terminate and deduplicate',()=>{
  const result=selectPrerequisites({...base,targets:['task','task'],edges:[...base.edges,edge('mid','root'),edge('missing','task'),{from:'unrelated',to:'task',kind:'related'}]},policy())
  expect(ids(result).sort()).toEqual(['mid','peer','root'])
  expect(result.foundations.every(f=>f.supports.length===1)).toBe(true)
})
test('recent suppression prevents a stale low score from reopening a taught foundation',()=>{
  expect(ids(selectPrerequisites({...base,suppressed:new Set(['root','peer'])},policy()))).toEqual(['mid'])
})

const catalog=base.catalogIds.map(id=>({id,title:id}))
const packet=(prerequisites:PrerequisitePolicy,extra:Partial<Parameters<typeof taskTeachingContext>[0]>={})=>
  taskTeachingContext({ids:['task'],catalog,edges:base.edges,assessments:[],suppressed:new Set(),gaps:[],foundationFirst:true,prerequisites,...extra})
const summary=(context:string)=>JSON.parse(context.split('\nPrerequisite selection: ')[1]!)

test('packet carries the selected prerequisites plus the task anchor within the wire limits',()=>{
  const out=packet(policy({count:2}))
  expect(out.conceptIds).toEqual(['peer','root','task'])
  expect(out.context).toContain('"supports":["task"]')
  expect(out.context.length).toBeLessThanOrEqual(4000)
  expect(summary(out.context)).toMatchObject({mode:'unknown',selected:2,depth:'all',count:2,strictness:100})
})
test('the count is honoured up to the 5-concept wire limit, which reserves one slot for the task anchor',()=>{
  for(const count of [1,2,3]) expect(packet(policy({count})).conceptIds.filter(id=>id!=='task')).toHaveLength(count)
  const roots=Array.from({length:12},(_,i)=>`root${i}`)
  const wide=taskTeachingContext({ids:['task'],catalog:[...roots,'task'].map(id=>({id,title:id})),edges:roots.map(id=>edge(id,'task')),assessments:[],suppressed:new Set(),gaps:[],foundationFirst:true,prerequisites:policy({count:5})})
  expect(wide.conceptIds).toHaveLength(5)
  expect(wide.conceptIds).toContain('task')
  expect(summary(wide.context)).toMatchObject({unmet:12,selected:4,omitted:8})
})
test('packet ranks real-shaped assessments but ignores stale or insufficient percentages',()=>{
  const assessment=(conceptId:string,percent:number,status='ready',confidence='medium')=>LearningConceptAssessmentSchema.parse({conceptId,status,assessedAt:'2026-09-07T00:00:00Z',runId:null,assessment:{conceptId,nodeVersion:'a'.repeat(64),understandingPercent:percent,confidence,demonstrated:[],gaps:[],nextCheck:'Explain the mechanism.',needsReview:true}})
  const out=packet(policy({count:1}),{assessments:[assessment('root',0,'stale'),assessment('peer',0,'ready','insufficient'),assessment('mid',25)]})
  expect(out.conceptIds).toEqual(['mid','task'])
  expect(out.context).toContain('"understandingPercent":25')
  expect(out.context).not.toContain('"understandingPercent":0')
})

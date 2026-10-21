import {describe,expect,test} from 'bun:test'
import {assessmentEvidenceProvenance} from './learning-assessment-evidence.js'

describe('assessment evidence identity',()=>{
  const source=(id:string,role:string)=>({id,role,conversationId:'conversation'})
  test('historical paired and orphan groups remain visible with exact persisted source IDs',()=>{
    const evidence=[source('human','user'),source('commentary','assistant'),source('final','assistant'),source('orphan','assistant'),source('prior-citation','user')]
    const result=assessmentEvidenceProvenance(evidence,{origin:'vector-selection',experimentId:'run',turns:[
      {id:'human',conversationId:'conversation',messageIds:['human','commentary','final'],linkage:'explicit'},
      {id:'orphan',conversationId:'conversation',messageIds:['orphan'],linkage:'unpaired'},
      {id:'other-batch',conversationId:'conversation',messageIds:['not-supplied'],linkage:'explicit'},
    ]})
    expect(result.sourceIds).toEqual(evidence.map(m=>m.id))
    expect(result.groups.flatMap(group=>group.messageIds)).toEqual(result.sourceIds)
    expect([result.completeTurns,result.unpairedGroups,result.unknownGroups]).toEqual([1,1,1])
    expect(result.groups[0]?.messageIds).toHaveLength(3)
  })
  test('a carry-over citation does not turn a partial group into a complete turn',()=>{
    const result=assessmentEvidenceProvenance([source('human','user')],{origin:'vector-selection',experimentId:'run',turns:[{id:'human',conversationId:'conversation',messageIds:['human','missing-assistant'],linkage:'explicit'}]})
    expect(result.completeTurns).toBe(0)
    expect(result.unpairedGroups).toBe(1)
  })
  test('legacy sources without recorded linkage remain unknown, not invented pairs',()=>{
    const result=assessmentEvidenceProvenance([source('human','user'),source('assistant','assistant')])
    expect(result.origin).toBe('legacy-assessment')
    expect(result.completeTurns).toBe(0)
    expect(result.unknownGroups).toBe(2)
  })
})

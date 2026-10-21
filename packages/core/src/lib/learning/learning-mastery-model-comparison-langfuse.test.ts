import {test,expect} from 'bun:test'
import {jevArmCost} from './learning-mastery-model-comparison-langfuse.js'

const row=(bill:{billed:boolean;inputTokens:number;usd:number|null}|null)=>({conceptId:'c',status:'completed',level:1,percent:null,durationMs:1,inputTokens:null,rateLimitRetries:0,scores:{},bill})
test('the Jev arm total sums Langfuse cost, keeps refusals at zero and flags unreadable or unpriced billing',()=>{
  const rows=[row({billed:true,inputTokens:1000,usd:.000042}),row({billed:true,inputTokens:2000,usd:.000084}),row({billed:false,inputTokens:0,usd:0})]
  expect(jevArmCost(rows)).toEqual({usd:.000126,billedCalls:2,unbilledRejections:1,unknownCalls:0,unpricedCalls:0,billedInputTokens:3000,complete:true,costSource:'langfuse model definitions'})
  expect(jevArmCost([...rows,row(null)])).toMatchObject({unknownCalls:1,complete:false,usd:.000126})
  expect(jevArmCost([...rows,row({billed:true,inputTokens:5,usd:null})])).toMatchObject({unpricedCalls:1,complete:false,usd:.000126})
})

import {DEFAULT_DECISION_SELECTION,listCapabilityModels} from '@learner/llm/lib/llm/model-catalog.js'
import {ASSESSMENT_MODEL,type AssessmentConcept,type AssessmentSource} from './learning-concept-assessment.js'
import {gradualAssessmentPrompt} from './learning-gradual-assessment.js'

export const MASTERY_AB_KIND='mastery-model-comparison'
export const MASTERY_AB_ARMS=['reference','flash','jev'] as const
export type MasteryArm=typeof MASTERY_AB_ARMS[number]
/** Receipt model identities. `killMs`/`timeout` apply to the CLI arms; Jev's HTTP call has its own 30 s ceiling. */
export const MASTERY_AB_MODELS={
  reference:{backend:'claude',model:'claude-opus-5-5',effort:'high',timeout:600,killMs:600_000,maxParseRetries:0,maxAttempts:1},
  flash:{...ASSESSMENT_MODEL},
  jev:{backend:'typesafe',model:DEFAULT_DECISION_SELECTION.model,effort:'none',timeout:30,killMs:30_000,maxParseRetries:0,maxAttempts:1},
} as const
export const MASTERY_AB_CONCURRENCY:Record<MasteryArm,number>={reference:3,flash:3,jev:10}
export const MASTERY_AB_QUEUES:Record<MasteryArm,string>={reference:'learning.mastery-ab-reference',flash:'learning.mastery-ab-flash',jev:'learning.mastery-ab-jev'}
// Density is content-dependent on this JSON evidence. Measured over 42 billed Jev requests (run 8d3a6b90, 2026-09-29):
// mean 2.31 chars/token, densest 1.82, and five ~60k-char requests overflowed 32k at 2.0. 1.6 sits under the densest.
export const CHARS_PER_TOKEN=1.6
export const BUDGET_MARGIN_TOKENS=1500

export const MASTERY_LEVELS=[
  'Insufficient evidence: the supplied human material supports no understanding estimate. Missing evidence is not 0% understanding.',
  'Limited but identifiable understanding (about 0-20%).',
  'Partial application (about 25-45%).',
  'Sound application with gaps (about 50-70%).',
  'Broad independent transfer (about 75-90%).',
  'Unusually comprehensive evidence (about 95-100%).',
] as const

/** Production rubric bands; null is the production "unknown" answer. */
export function percentToLevel(percent:number|null):number {
  if(percent===null)return 0
  if(!Number.isInteger(percent)||percent<0||percent>100||percent%5)throw new Error('Understanding percent must be a five-point increment in 0..100')
  return percent<=20?1:percent<=45?2:percent<=70?3:percent<=90?4:5
}

// Production prompt paragraphs that define WHAT counts as understanding. The
// excluded ones only govern quote copying and the JSON response shape, which a
// score question has no equivalent of. Matched by their opening words so a
// prompt revision that moves or drops one fails loudly instead of silently.
const RUBRIC_OPENINGS=['OBJECTIVE:','Assess provisional','Give your best','Assess this supplied','Use null','Use your judgment','AUTHORITY:','Read the supplied','EVIDENCE DEFINITIONS:','Distinguish (1)','A following assistant','OUTCOME:']
export function masteryRubricInstructions() {
  const paragraphs=gradualAssessmentPrompt({nodeStates:[],nativeObservations:[],evidence:[]}).split('\n\n')
  const chosen=RUBRIC_OPENINGS.map(opening=>{
    const found=paragraphs.filter(p=>p.startsWith(opening))
    if(found.length!==1)throw new Error(`Production assessment rubric paragraph not found exactly once: ${opening}`)
    return found[0]!
  })
  return [
    'Assess ONE supplied leaf concept for the human learner using the production assessment criteria below. The state holds the concept (title, description, learning objectives) and the supplied conversation evidence in chronological order.',
    ...chosen,
    'ANSWER MAPPING: choose the single level whose descriptor best matches your evidence-supported estimate. Use level 0 exactly when the criteria above call for null (unknown). Levels 1-5 correspond to the suggested percentage anchors.',
  ].join('\n\n')
}

export function jevMasteryRequest(concept:AssessmentConcept,evidence:AssessmentSource[]) {
  return {
    state:{concept:{title:concept.title,description:concept.description,objectives:concept.objectives},evidence},
    questions:{mastery:{type:'score' as const,instructions:masteryRubricInstructions(),criteria:[...MASTERY_LEVELS]}},
  }
}

/** Evidence tokens left after the concept, rubric and level descriptors, under Jev's per-request cap. */
export function jevEvidenceBudget(concept:AssessmentConcept) {
  const limit=listCapabilityModels('score').find(m=>m.provider==='typesafe'&&m.id===MASTERY_AB_MODELS.jev.model)?.limits?.statePlusLongestQuestionTokens
  if(!limit)throw new Error('Jev score capability has no catalogued input limit')
  const fixed=Math.ceil(JSON.stringify(jevMasteryRequest(concept,[])).length/CHARS_PER_TOKEN)
  return {limitTokens:limit,fixedTokens:fixed,marginTokens:BUDGET_MARGIN_TOKENS,maxEvidenceTokens:limit-fixed-BUDGET_MARGIN_TOKENS}
}

export type MasteryDecision={level:number;expectedScore:number;probabilities:Record<string,number>;confidence:number;legend:Record<string,unknown>;returnedModel:string;usage:unknown}
/** A score answer's `score` is the expectation over its distribution; the level is the most probable one (ties go down). */
export function decisionFromAnswer(answer:Record<string,any>,returnedModel:string,usage:unknown):MasteryDecision {
  const p=MASTERY_LEVELS.map((_,i)=>answer.probabilities?.[String(i)])
  if(!p.every(v=>typeof v==='number'&&v>=0)||typeof answer.score!=='number')throw new Error('Jev score is not a distribution over the supplied levels')
  const level=p.reduce((best,v,i)=>v>p[best]!?i:best,0)
  return {level,expectedScore:answer.score,probabilities:answer.probabilities,confidence:answer.confidence,legend:answer.legend,returnedModel,usage}
}

/**
 * What Jev billed for one receipt, as usage; Langfuse prices it. The decision's usage when it completed;
 * otherwise the preserved provider body, since a response our validator rejected was still billed.
 * A refusal that returned no usage is unbilled; anything unreadable is null (unknown), never guessed.
 */
export function jevBilledUsage(receipt:{decision?:MasteryDecision|null;raw?:string|null}) {
  let usage:any=receipt.decision?.usage,model=receipt.decision?.returnedModel
  if(!receipt.decision){
    let body:any
    try{body=JSON.parse(receipt.raw??'')}catch{return null}
    if(typeof body?.detail?.error_type==='string'&&body.usage===undefined)return {billed:false,model:null,inputTokens:0,outputTokens:0,reason:body.detail.error_type as string}
    usage=body?.usage;model=body?.model
  }
  const input=usage?.input_tokens
  if(typeof model!=='string'||!Number.isSafeInteger(input)||input<0)return null
  return {billed:true,model,inputTokens:input as number,outputTokens:Number.isSafeInteger(usage.output_tokens)?usage.output_tokens as number:0,reason:null}
}

type Outcome={status:string;level:number|null;percent:number|null;durationMs:number;decision?:MasteryDecision|null}
/** Pre-registered accuracy scores against the agent reference. A failed candidate is wrong, not skipped. */
export function masteryArmScores(reference:Outcome,candidate:Outcome,arm:MasteryArm) {
  if(arm==='reference')return {call_latency_ms:candidate.durationMs}
  if(reference.status!=='completed'||reference.level===null)return {call_latency_ms:candidate.durationMs}
  const ok=candidate.status==='completed'&&candidate.level!==null
  const error=ok?Math.abs(candidate.level!-reference.level):MASTERY_LEVELS.length-1
  const scores:Record<string,number|boolean>={
    level_exact:ok&&error===0,level_within_one:ok&&error<=1,
    evidence_decision_agrees:ok&&(candidate.level===0)===(reference.level===0),
    level_abs_error:error,call_latency_ms:candidate.durationMs,
  }
  if(arm==='flash'&&ok&&candidate.percent!==null&&reference.percent!==null)scores.percent_abs_error=Math.abs(candidate.percent-reference.percent)
  if(arm==='jev'&&ok&&candidate.decision){
    const p=candidate.decision.probabilities
    scores.ref_level_probability=p[String(reference.level)]??0
    scores.expected_level=Object.entries(p).reduce((sum,[level,probability])=>sum+Number(level)*probability,0)
    scores.confidence=candidate.decision.confidence
  }
  return scores
}
export const MASTERY_AB_SCORE_TYPES:Record<string,{dataType:'BOOLEAN'|'NUMERIC';maxValue?:number}>={
  level_exact:{dataType:'BOOLEAN'},level_within_one:{dataType:'BOOLEAN'},evidence_decision_agrees:{dataType:'BOOLEAN'},
  level_abs_error:{dataType:'NUMERIC',maxValue:5},percent_abs_error:{dataType:'NUMERIC',maxValue:100},call_latency_ms:{dataType:'NUMERIC'},
  ref_level_probability:{dataType:'NUMERIC',maxValue:1},expected_level:{dataType:'NUMERIC',maxValue:5},confidence:{dataType:'NUMERIC',maxValue:1},
}

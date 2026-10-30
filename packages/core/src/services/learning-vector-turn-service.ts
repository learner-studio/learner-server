import { Pool } from 'pg'
import { repoRoot } from '../lib/repo-root.js'
import { hindsightDatabaseUrl, hindsightHfHome, hindsightPython } from '../lib/learning/hindsight-database.js'
import { spawn } from 'node:child_process'
import { sql, type Kysely } from 'kysely'
import type { DB } from '../types/db.types.js'
import type { LearningConceptAssessmentService } from './learning-concept-assessment.js'
import { conceptFromGraphs } from './learning-concept-assessment.js'
import type { LearningGraph } from '../functions/learning/learning-seed.js'
import type { LearningCurriculumStore } from './learning-curriculum-store.js'
import { assessmentHash, sameAssessmentConcept, type AssessmentConcept, type AssessmentSource, type LearningConceptAssessment, type LearningAssessmentRun } from '../lib/learning/learning-concept-assessment.js'
import { GRADUAL_ASSESSMENT_REVISION } from '../lib/learning/learning-gradual-assessment.js'
import { coldChainPrior, coldPassResult, liveIncrementalInput, mergeIncrementalAssessment } from '../lib/learning/learning-incremental-assessment.js'
import { LIVE_INCREMENTAL_VARIANT, isCurrentAssessmentRevision } from '../lib/learning/learning-live-incremental-variant.js'
import { VectorTurnConfig, reconstructVectorTurns, selectVectorTurns, selectUnseenVectorTurns, coldVectorParts, extendVectorCoverage, publishedVectorCoverage, partitionVectorTurns, assertVectorPromptBudget, vectorRunMetadata, type VectorConfig, type VectorMessage, type VectorTurn, type VectorUserIdentity } from '../lib/learning/learning-vector-turns.js'
import { metaDbQuery } from '../lib/db-metadata/_shared.js'
import { remainingVectorBatches, nativeTurnAnchors, type NativeLinkRow } from '../lib/learning/learning-vector-turns.js'
import { LIVE_COLD_SLICES } from '../lib/learning/learning-vector-turn-schemas.js'

type Selection = { concept:AssessmentConcept; prior?:LearningConceptAssessment['assessment']|undefined; matchingChunks:number; matchingMessages:number; matchingTurns:number; matchingCompleteTurns?:number; matchingUnpairedTurns?:number; bankMatchingUnits:number; exhaustive:boolean; turns:VectorTurn[]; parts:string[][]; covered?:string[]; context?:VectorTurn[] }
type ExecutionChange={requestId:string;at:string;concurrency:number;previousConcurrency:number;previousWorkflowId:string;settledParts:number;scheduling?:'rolling'}
type Snapshot = { messages:VectorMessage[]; selections:Selection[]; metadata:ReturnType<typeof vectorRunMetadata>&{executionChanges?:ExecutionChange[]}; counts:{messages:number;chunks:number;turns:number;unpaired:number}; batches:Array<Array<{conceptId:string;part:number}>> }
type Row = {run_id:string;user_id:string;config:VectorConfig;snapshot:Snapshot|null;status:string;created_at:Date;finished_at:Date|null}

export class LearningVectorTurnService {
  readonly reactiveRevision='reactive-v1'
  constructor(private readonly db:Kysely<DB>, private readonly assessments:LearningConceptAssessmentService, private readonly curricula:LearningCurriculumStore) {}
  private async row(runId:string,userId?:string):Promise<Row> {
    const r=(await metaDbQuery<Row>('SELECT * FROM learning_vector_turn_experiments WHERE run_id=$1',[runId])).rows[0]
    if(!r || userId && r.user_id!==userId) throw new Error('Experiment not found')
    return r
  }
  async create(runId:string,userId:string,config:VectorConfig) {
    if(config.baseRunId) {
      const base=await this.row(config.baseRunId,userId)
      const state=await this.inspect(base.run_id,userId)
      if(!['completed','partial','cancelled','failed'].includes(state.status)) throw new Error('Baseline must be terminal before continuation')
      const inFlight=await metaDbQuery(`SELECT 1 FROM learning_concept_assessment_runs r JOIN learning_concept_assessment_attempts a USING(run_id)
        LEFT JOIN learning_concept_assessment_receipts t USING(run_id) WHERE r.snapshot->>'experimentId'=$1 AND t.run_id IS NULL LIMIT 1`,[base.run_id])
      if(inFlight.rowCount) throw new Error('Baseline paid calls must settle before selecting remaining concepts')
      let ancestor:string|undefined=config.baseRunId
      const seen=new Set([runId])
      while(ancestor) {
        if(seen.has(ancestor)||seen.size>=8) throw new Error('Invalid experiment lineage')
        seen.add(ancestor);ancestor=(await this.row(ancestor,userId)).config.baseRunId
      }
    }
    await metaDbQuery('INSERT INTO learning_vector_turn_experiments(run_id,user_id,config) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',[runId,userId,JSON.stringify(config)])
    const row=await this.row(runId,userId)
    if(JSON.stringify(row.config)!==JSON.stringify(config) && assessmentHash(VectorTurnConfig.parse(row.config))!==assessmentHash(config)) throw new Error('Run ID reused with different configuration')
  }
  async embeddings(texts:string[]):Promise<number[][]> {
    const child=spawn(hindsightPython(),['scripts/hindsight/learning-vector-query-embeddings.py'],{
      cwd:repoRoot,env:{...process.env,HF_HOME:hindsightHfHome(),HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',OMP_NUM_THREADS:'8',MKL_NUM_THREADS:'8',TOKENIZERS_PARALLELISM:'false'},stdio:['pipe','pipe','pipe']})
    let output='';let error=''
    child.stdout.on('data',c=>{output+=c});child.stderr.on('data',c=>{error+=c})
    const timer=setTimeout(()=>child.kill('SIGKILL'),180000)
    child.stdin.end(JSON.stringify(texts))
    try { await new Promise<void>((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(`Local query embedding failed: ${error.slice(-500)}`)))}) }
    finally { clearTimeout(timer) }
    const result=JSON.parse(output) as number[][]
    if(result.length!==texts.length || result.some(v=>v.length!==384||v.some(n=>!Number.isFinite(n)))) throw new Error('Query embedding shape mismatch')
    return result
  }
  async prepare(runId:string) {
    const row=await this.row(runId)
    if(row.snapshot) {
      const done=(await metaDbQuery<{concept_id:string;part:number}>('SELECT a.concept_id,a.part FROM learning_vector_turn_assessments a JOIN learning_concept_assessment_receipts t USING(run_id) WHERE a.experiment_id=$1',[runId])).rows
      const concurrency=row.snapshot.metadata.executionChanges?.at(-1)?.concurrency??row.config.concurrency
      return {batches:remainingVectorBatches(row.snapshot.batches,new Set(done.map(item=>`${item.concept_id}:${item.part}`)),concurrency),concurrency}
    }
    const snapshot=await this.selectEvidence(row.config,row.user_id,runId)
    await metaDbQuery("UPDATE learning_vector_turn_experiments SET snapshot=$2::jsonb,status='running' WHERE run_id=$1 AND snapshot IS NULL",[runId,JSON.stringify(snapshot)])
    return {batches:snapshot.batches,concurrency:row.config.concurrency}
  }

  /** Shared read-only selector for manual and reactive consolidation. */
  async selectEvidence(config:VectorConfig,userId:string,runId:string):Promise<Snapshot> {
    const row={config,user_id:userId}
    // One repeatable-read source snapshot per execution, not a permanently frozen dev1 label.
    const frozen=await this.db.transaction().setIsolationLevel('repeatable read').execute(async trx=>{
      const messages=(await sql<VectorMessage>`SELECT message_id AS id,conversation_id AS "conversationId",role,source_text AS text,
        observed_at::text AS "occurredAt",logical_message_key AS "logicalKey",payload->>'authorship' AS authorship,payload->'correlation' AS correlation,
        COALESCE((payload->'correlation'->>'sourceOrder')::float8,0) AS "sourceOrder",raw_version_id::text AS "sourceVersion"
        FROM learning_semantic_index_messages message WHERE current_canonical AND status IN ('indexed','empty')
          AND NOT EXISTS(SELECT 1 FROM learning_cli_vector_e2e_runs fixture
            WHERE fixture.mastery_excluded AND message.conversation_id IN (fixture.session_id::text,'claude:'||fixture.session_id::text))
        ORDER BY conversation_id,observed_at,message_id`.execute(trx)).rows
      const chunks=(await sql<{id:string;messageId:string}>`SELECT c.chunk_id AS id,c.message_id AS "messageId" FROM learning_semantic_index_chunks c JOIN learning_semantic_index_messages m USING(message_id)
        WHERE m.current_canonical AND m.status='indexed' AND c.status='indexed'`.execute(trx)).rows
      // Identity ambiguity is checked across ALL observations, not only indexed
      // canonical messages. A second input outside this snapshot still blocks pairing.
      const users=(await sql<VectorUserIdentity>`SELECT DISTINCT logical_message_key AS "logicalKey",
        COALESCE(NULLIF(payload->'correlation'->>'conversationId',''),NULLIF(payload->'correlation'->>'codexThreadId',''),
          NULLIF(payload->'correlation'->>'sessionId',''),NULLIF(payload->'correlation'->>'sessionKey',''),
          NULLIF(payload->'correlation'->>'threadId',''),NULLIF(payload->'correlation'->>'nativeConversationId',''),
          CASE WHEN logical_message_key LIKE 'claude:%' THEN 'claude:'||split_part(logical_message_key,':',2) END,
          'unlinked:'||logical_message_key) AS "conversationId",payload->'correlation' AS correlation
        FROM learning_exposure_observations observation WHERE direction='user_to_model' AND logical_message_key IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM learning_cli_vector_e2e_runs fixture WHERE fixture.mastery_excluded
            AND fixture.session_id::text=COALESCE(NULLIF(observation.payload->'correlation'->>'conversationId',''),
              NULLIF(observation.payload->'correlation'->>'codexThreadId',''),NULLIF(observation.payload->'correlation'->>'sessionId',''),
              NULLIF(observation.payload->'correlation'->>'sessionKey',''),NULLIF(observation.payload->'correlation'->>'threadId',''),
              NULLIF(observation.payload->'correlation'->>'nativeConversationId','')))
        `.execute(trx)).rows
      const links=(await sql<NativeLinkRow>`SELECT logical_message_key AS "logicalKey",payload->'correlation'->>'parentUuid' AS "parentUuid",
        (direction='user_to_model' AND payload->>'authorship'='human') AS human
        FROM learning_exposure_observations WHERE logical_message_key LIKE 'claude:%' ORDER BY observed_at,inserted_at,observation_id`.execute(trx)).rows
      return {messages,chunks,users,links}
    })
    // Claude-format replies reach their prompt only by the native parent chain.
    const anchors=nativeTurnAnchors(frozen.links)
    for(const m of frozen.messages) {
      const anchor=m.role==='assistant'&&m.correlation.parentLogicalMessageKey===undefined?anchors.get(m.logicalKey):undefined
      if(anchor) m.correlation={...m.correlation,parentLogicalMessageKey:anchor}
    }
    const turns=reconstructVectorTurns(frozen.messages,frozen.users)
    const messages=new Map(frozen.messages.map(m=>[m.id,m]))
    const chunkMap=new Map(frozen.chunks.map(c=>[c.id,c.messageId]))
    const graphs=await this.curricula.listGraphs()
    const allIds=new Set(graphs.flatMap(g=>g.concepts.map(c=>c.id)))
    const conceptIds=[...new Set(row.config.conceptIds??allIds)]
    if(conceptIds.some(id=>!allIds.has(id))) throw new Error('Unknown assessment concept ID')
    const concepts=await Promise.all(conceptIds.map(id=>this.assessments.concept(id)))
    // A cold pass reads no published estimate and no coverage: it regrades the concept's whole history from scratch.
    const cold=row.config.incremental&&row.config.priorMode==='cold'
    const priorByConcept=new Map((row.config.purpose==='live'&&!cold?(await this.lookupAssessments(row.user_id,graphs)).assessments:[]).filter(item=>item.status==='ready'||item.status==='pending').map(item=>[item.conceptId,item.assessment]))
    const coverage=row.config.incremental&&!cold?await this.publishedCoverage(row.user_id,[...priorByConcept.keys()]):new Map<string,Set<string>>()
    const vectors=await this.embeddings(concepts.map(c=>`${c.title}\n${c.description}`))
    // This connection is used solely for a fixed SELECT against the dedicated bank.
    // Native Hindsight uses peer-authenticated Unix sockets. Reuse the existing
    // app role, granted SELECT only on our canonical-bank integration view.
    if(process.env.LEARNING_VECTOR_TURNS_READ_VIEW_ENABLED!=='true') throw new Error('Native read-only integration view is not enabled')
    const connection=new URL(hindsightDatabaseUrl())
    const pool=new Pool({connectionString:connection.toString(),max:1,options:'-c default_transaction_read_only=on -c search_path=public'})
    const selections:Selection[]=[]
    try {
      await pool.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const indexed=(await pool.query<{document_id:string}>(`SELECT DISTINCT document_id FROM public.learner_learning_vectors`)).rows
      const searchable=new Set(indexed.map(item=>item.document_id))
      const missing=frozen.chunks.filter(chunk=>!searchable.has(chunk.id))
      if(missing.length) throw new Error(`Native vector coverage incomplete: ${missing.length} frozen indexed chunks have no embedding; exhaustive assessment refused`)
      for(const [index,concept] of concepts.entries()) {
        // MATERIALIZED scoring prevents ANN top-K truncation. No rank/limit in all mode.
        const hits=(await pool.query<{document_id:string;score:number}>(`WITH scored AS MATERIALIZED (
          SELECT document_id,1-(embedding <=> $1::vector) AS score FROM public.learner_learning_vectors)
          SELECT document_id,MAX(score) AS score FROM scored WHERE score >= $2 GROUP BY document_id`,[JSON.stringify(vectors[index]),row.config.threshold])).rows
        const eligible=[...new Map(hits.filter(h=>chunkMap.has(h.document_id)).map(h=>[h.document_id,h])).values()]
        const matchingIds=new Set(eligible.map(h=>chunkMap.get(h.document_id)!))
        const scores=new Map<string,number>()
        for(const hit of eligible) {const id=chunkMap.get(hit.document_id)!;scores.set(id,Math.max(scores.get(id)??-Infinity,hit.score))}
        // Incremental passes chain from the published estimate, so only its unseen turns are graded;
        // with nothing unseen there are no parts and no model call.
        const covered=coverage.get(concept.conceptId)??new Set<string>()
        const coldPlan=cold?coldVectorParts(selectUnseenVectorTurns(turns,matchingIds,covered,messages),messages,row.config.maxInputTokens,LIVE_COLD_SLICES):null
        const selected=coldPlan?.turns??(row.config.incremental?selectUnseenVectorTurns(turns,matchingIds,covered,messages):selectVectorTurns(turns,matchingIds,row.config,scores))
        const parts=coldPlan?.parts??(row.config.incremental&&!selected.length?[]:partitionVectorTurns(selected,messages,row.config.maxInputTokens).map(batch=>batch.flatMap(t=>t.messageIds)))
        // A window over budget is graded as chronological parts, each packed as full as the budget
        // allows; preparePart carries every part's estimate into the next as its prior.
        selections.push({concept,prior:priorByConcept.get(concept.conceptId),matchingChunks:eligible.length,matchingMessages:matchingIds.size,
          matchingTurns:turns.filter(t=>t.messageIds.some(id=>matchingIds.has(id))).length,
          matchingCompleteTurns:turns.filter(t=>t.linkage==='explicit'&&t.messageIds.some(id=>matchingIds.has(id))).length,
          matchingUnpairedTurns:turns.filter(t=>t.linkage==='unpaired'&&t.messageIds.some(id=>matchingIds.has(id))).length,
          bankMatchingUnits:hits.length,exhaustive:row.config.incremental||row.config.selection==='all',turns:selected,parts,
          ...(row.config.incremental?{covered:extendVectorCoverage(covered,parts,messages),
            // Matching turns the estimate already reflects: the v6 prompt's read-only context, never evidence.
            context:turns.filter(t=>t.linkage==='explicit'&&t.messageIds.some(id=>matchingIds.has(id))&&!selected.some(s=>s.id===t.id))}:{})})
      }
      await pool.query('COMMIT')
    } finally {await pool.end()}
    const work=selections.map(s=>s.parts.map((_,part)=>({conceptId:s.concept.conceptId,part})))
    // Round-robin parts preserve per-concept chronology and cap simultaneous model calls.
    const batches:Snapshot['batches']=[]
    for(let part=0;part<Math.max(...work.map(w=>w.length));part++) {
      const wave=work.flatMap(w=>w[part]?[w[part]!]:[])
      for(let offset=0;offset<wave.length;offset+=row.config.concurrency) batches.push(wave.slice(offset,offset+row.config.concurrency))
    }
    const inputHash=assessmentHash({sources:frozen.messages.map(m=>[m.id,m.sourceVersion,assessmentHash(m.text)]),selections:selections.map(s=>[s.concept,s.parts])})
    // Store only the messages a reader can reach (parts, turns, read-only context).
    // Storing every indexed message cost ~8 MB per pass and filled the disk.
    const kept=new Set(selections.flatMap(s=>[...s.parts.flat(),...s.turns.flatMap(t=>t.messageIds),...(s.context??[]).flatMap(t=>t.messageIds)]))
    const snapshot:Snapshot={messages:frozen.messages.filter(m=>kept.has(m.id)),selections,batches,metadata:vectorRunMetadata(runId,row.config,inputHash,row.config.incremental?LIVE_INCREMENTAL_VARIANT.revision:GRADUAL_ASSESSMENT_REVISION),
      counts:{messages:frozen.messages.length,chunks:frozen.chunks.length,turns:turns.filter(t=>t.linkage==='explicit').length,unpaired:turns.filter(t=>t.linkage==='unpaired').length}}
    return snapshot
  }
  /** What each published live estimate has already graded, read through its run back to the pass that produced it. */
  private async publishedCoverage(userId:string,conceptIds:string[]) {
    const coverage=new Map<string,Set<string>>()
    if(!conceptIds.length) return coverage
    const published=(await metaDbQuery<{concept_id:string;run_id:string;experiment_id:string|null;covered:string[]|null}>(`SELECT c.concept_id,c.run_id,r.snapshot->>'experimentId' AS experiment_id,
        (SELECT s->'covered' FROM learning_vector_turn_experiments e,jsonb_array_elements(e.snapshot->'selections') s
          WHERE e.run_id::text=r.snapshot->>'experimentId' AND s#>>'{concept,conceptId}'=c.concept_id) AS covered
      FROM learning_concept_assessment_cache c JOIN learning_concept_assessment_runs r USING(run_id) WHERE c.user_id=$1 AND c.concept_id=ANY($2)`,[userId,conceptIds])).rows
    for(const item of published) {
      type Evidence={evidence:Array<{id:string;sourceVersion:string}>}
      const evidence=(item.experiment_id
        ? await metaDbQuery<Evidence>(`SELECT r.snapshot->'evidence' AS evidence FROM learning_vector_turn_assessments a JOIN learning_concept_assessment_runs r USING(run_id) WHERE a.experiment_id::text=$1 AND a.concept_id=$2`,[item.experiment_id,item.concept_id])
        : await metaDbQuery<Evidence>(`SELECT snapshot->'evidence' AS evidence FROM learning_concept_assessment_runs WHERE run_id=$1`,[item.run_id])).rows
      coverage.set(item.concept_id,publishedVectorCoverage(item.covered?{covered:item.covered}:undefined,evidence.map(row=>row.evidence)))
    }
    return coverage
  }
  /** Incremental passes for one concept, oldest first, each checked against the coverage it chained from:
   * the last COMPLETED pass, since a failed pass publishes nothing. Null when no earlier pass is known. */
  async coverageHistory(userId:string,conceptId:string,limit:number) {
    const rows=(await metaDbQuery<{run_id:string;created_at:Date;status:string;covered:string[]|null;turns:Array<{messageIds:string[]}>|null;parts:unknown[]|null;versions:Record<string,string>|null}>(`
      SELECT e.run_id,e.created_at,e.status,sel->'covered' AS covered,sel->'turns' AS turns,sel->'parts' AS parts,
        (SELECT jsonb_object_agg(m->>'id',m->>'sourceVersion') FROM jsonb_array_elements(e.snapshot->'messages') m
          WHERE m->>'id' IN (SELECT jsonb_array_elements_text(t->'messageIds') FROM jsonb_array_elements(sel->'turns') t)) AS versions
      FROM learning_vector_turn_experiments e
      LEFT JOIN LATERAL (SELECT s AS sel FROM jsonb_array_elements(e.snapshot->'selections') s WHERE s#>>'{concept,conceptId}'=$2) picked ON true
      WHERE e.user_id=$1 AND COALESCE((e.config->>'incremental')::boolean,false) AND e.config->'conceptIds' ? $2
      ORDER BY e.created_at DESC LIMIT $3`,[userId,conceptId,limit])).rows.reverse()
    let previous:Set<string>|null=null
    return rows.map(row=>{
      const covered=new Set(row.covered??[])
      const turns=row.turns??[]
      const regraded=previous?turns.filter(t=>t.messageIds.every(id=>previous!.has(`${id}@${row.versions?.[id]}`))).length:null
      const pass={runId:row.run_id,createdAt:row.created_at.toISOString(),status:row.status,turns:turns.length,parts:row.parts?.length??0,covered:covered.size,
        newlyCovered:previous?[...covered].filter(key=>!previous!.has(key)).length:covered.size,regradedCoveredTurns:regraded,
        coverageShrank:previous?[...previous].some(key=>!covered.has(key)):false}
      if(row.status==='completed'&&row.covered) previous=covered
      return pass
    })
  }
  /** Concepts whose incremental passes ran most recently. */
  async recentIncrementalConcepts(userId:string,count:number) {
    return (await metaDbQuery<{concept_id:string}>(`SELECT concept_id FROM (SELECT e.config->'conceptIds'->>0 AS concept_id,MAX(e.created_at) AS at FROM learning_vector_turn_experiments e
      WHERE e.user_id=$1 AND COALESCE((e.config->>'incremental')::boolean,false) GROUP BY 1) recent ORDER BY at DESC LIMIT $2`,[userId,count])).rows.map(row=>row.concept_id)
  }
  async preparePart(runId:string,conceptId:string,part:number) {
    const row=await this.row(runId);const snapshot=row.snapshot!
    const existing=(await metaDbQuery<{run_id:string}>('SELECT run_id FROM learning_vector_turn_assessments WHERE experiment_id=$1 AND concept_id=$2 AND part=$3',[runId,conceptId,part])).rows[0]
    if(existing) return {runId:existing.run_id}
    if(snapshot.metadata.consolidatorConfig.promptRevision!==(row.config.incremental?LIVE_INCREMENTAL_VARIANT.revision:GRADUAL_ASSESSMENT_REVISION)) throw new Error('Frozen selection uses an earlier assessment prompt; preserve its evidence and create a new explicit run instead')
    const selected=snapshot.selections.find(s=>s.concept.conceptId===conceptId)
    if(!selected || !Number.isInteger(part) || part<0 || !selected.parts[part]) throw new Error('Unknown concept evidence batch')
    const prior=row.config.incremental&&row.config.priorMode==='cold'?await this.coldPrior(runId,conceptId,part):await this.warmPrior(runId,conceptId,part,row.config.incremental,selected.prior)
    const ids=new Set(selected.parts[part])
    // Prior assessments remain historical metadata, never an evidence selector.
    const sources=new Map(snapshot.messages.map(m=>[m.id,m]))
    const evidence=[...ids].map(id=>{const source=sources.get(id);if(!source) throw new Error('A selected source is missing from the immutable snapshot');return source})
    let incremental:Parameters<LearningConceptAssessmentService['prepareProvided']>[7]
    if(row.config.incremental) incremental={revision:LIVE_INCREMENTAL_VARIANT.revision,built:liveIncrementalInput({concept:selected.concept,prior,parts:selected.parts,part,turns:selected.turns,
      context:selected.context??[],sources,contextAllowanceBytes:row.config.contextAllowanceBytes,maxInputBytes:row.config.maxInputTokens,variant:LIVE_INCREMENTAL_VARIANT})}
    else assertVectorPromptBudget(selected.concept,evidence,prior,row.config.maxInputTokens)
    const assessmentId=await this.assessments.prepareProvided(row.user_id,selected.concept,`${runId}:${conceptId}:${part}`,evidence,prior,runId,row.config.purpose==='live',incremental)
    await metaDbQuery('INSERT INTO learning_vector_turn_assessments(experiment_id,concept_id,part,run_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[runId,conceptId,part,assessmentId])
    return {runId:assessmentId}
  }
  /** Warm chain: each part takes the previous part's estimate (with its earlier demonstrations), the first takes the published one. */
  private async warmPrior(runId:string,conceptId:string,part:number,incremental:boolean,published:LearningConceptAssessment['assessment']|undefined) {
    const previous=(await metaDbQuery<{receipt:{assessment:LearningConceptAssessment['assessment'];status:string};snapshot:{evidence:AssessmentSource[];prior:LearningConceptAssessment['assessment']}}>(`SELECT t.receipt,r.snapshot FROM learning_vector_turn_assessments a JOIN learning_concept_assessment_runs r USING(run_id)
      JOIN learning_concept_assessment_receipts t USING(run_id) WHERE a.experiment_id=$1 AND a.concept_id=$2 AND a.part=$3`,[runId,conceptId,part-1])).rows[0]
    if(part>0 && !['completed','no_evidence','unchanged'].includes(previous?.receipt.status??'')) throw new Error('Earlier evidence batch did not complete; later estimate refused')
    // A v6 part lists only its own demonstrations; carry the chain's earlier ones into the next prior.
    return incremental&&previous?.receipt.assessment?mergeIncrementalAssessment(previous.snapshot.prior,previous.receipt.assessment):previous?.receipt.assessment??published??null
  }
  /** Cold chain (the v2-cold arm): no prior for part 0, then the raw last completed estimate; a failed part is skipped. */
  private async coldPrior(runId:string,conceptId:string,part:number) {
    const earlier=(await metaDbQuery<{part:number;receipt:{assessment:LearningConceptAssessment['assessment'];status:string}|null}>(`SELECT a.part,t.receipt FROM learning_vector_turn_assessments a
      LEFT JOIN learning_concept_assessment_receipts t USING(run_id) WHERE a.experiment_id=$1 AND a.concept_id=$2 AND a.part<$3 ORDER BY a.part`,[runId,conceptId,part])).rows
    return coldChainPrior(earlier,part)
  }
  async finish(runId:string) {
    const state=await this.inspect(runId)
    const status=state.pending ? 'partial' : state.failed ? 'partial':'completed'
    await metaDbQuery('UPDATE learning_vector_turn_experiments SET status=$2,finished_at=now() WHERE run_id=$1',[runId,status])
    return {runId,status}
  }
  async recordExecutionChange(runId:string,userId:string,requestId:string,concurrency:number) {
    const row=await this.row(runId,userId)
    // A completed pass has nothing left to run, and reopening it would unpublish its readings (learning_mastery_readings).
    if(row.status==='completed') throw new Error('A completed pass is published; continuation refused')
    if(!row.snapshot) throw new Error('A retained source snapshot is required for continuation')
    const latest=(await metaDbQuery<{workflow_run_id:string;status:string}>(`SELECT workflow_run_id,status FROM learner_workflow_runs WHERE workflow='learningVectorTurnWorkflow' AND input::jsonb->>'runId'=$1 ORDER BY created_at DESC LIMIT 1`,[runId])).rows[0]
    if(!latest||!['completed','failed','cancelled'].includes(latest.status)) throw new Error('Previous parent must be terminal before continuation')
    const pending=(await metaDbQuery(`SELECT a.run_id FROM learning_concept_assessment_runs r JOIN learning_concept_assessment_attempts a USING(run_id) LEFT JOIN learning_concept_assessment_receipts t USING(run_id) WHERE r.snapshot->>'experimentId'=$1 AND t.run_id IS NULL`,[runId])).rowCount
    if(pending) throw new Error('Paid attempts still lack receipts; continuation refused')
    const previousChange=row.snapshot.metadata.executionChanges?.find(change=>change.requestId===requestId)
    if(previousChange) {
      if(previousChange.concurrency!==concurrency) throw new Error('Continuation request ID reused with different concurrency')
      return
    }
    const settled=(await metaDbQuery('SELECT a.run_id FROM learning_vector_turn_assessments a JOIN learning_concept_assessment_receipts t USING(run_id) WHERE a.experiment_id=$1',[runId])).rowCount
    const change:ExecutionChange={requestId,at:new Date().toISOString(),concurrency,previousConcurrency:row.snapshot.metadata.executionChanges?.at(-1)?.concurrency??row.config.concurrency,previousWorkflowId:latest.workflow_run_id,settledParts:settled??0,scheduling:'rolling'}
    await metaDbQuery(`UPDATE learning_vector_turn_experiments SET snapshot=jsonb_set(snapshot,'{metadata,executionChanges}',COALESCE(snapshot#>'{metadata,executionChanges}','[]'::jsonb)||$2::jsonb),status='running',finished_at=NULL WHERE run_id=$1`,[runId,JSON.stringify([change])])
  }
  async inspect(runId:string,userId?:string):Promise<import('../lib/learning/learning-vector-turn-schemas.js').VectorExperiment & {metadata:(Snapshot['metadata'] & {baseRunId:string|null;inheritedConceptIds:string[]})|null}> {
    const row=await this.row(runId,userId)
    const workflow=(await metaDbQuery<{status:string;updated_at:Date}>(`SELECT status,updated_at FROM learner_workflow_runs WHERE workflow='learningVectorTurnWorkflow' AND input::jsonb->>'runId'=$1 ORDER BY created_at DESC LIMIT 1`,[runId])).rows[0]
    const interrupted=workflow && ['failed','cancelled','canceled'].includes(workflow.status)
    const status=interrupted?workflow.status:row.status
    const finishedAt=row.finished_at??(interrupted?workflow.updated_at:null)
    const results=(await metaDbQuery<{concept_id:string;part:number;run_id:string;receipt:LearningAssessmentRun['receipt']}>(`SELECT a.concept_id,a.part,a.run_id,t.receipt FROM learning_vector_turn_assessments a LEFT JOIN learning_concept_assessment_receipts t USING(run_id) WHERE experiment_id=$1 ORDER BY concept_id,part`,[runId])).rows
    const cold=row.config.incremental&&row.config.priorMode==='cold'
    const items=(row.snapshot?.selections??[]).map(s=>{
      const parts=results.filter(r=>r.concept_id===s.concept.conceptId)
      // A cold pass settles on its last completed part; a failed slice is skipped, never fatal while another completed.
      const coldResult=cold?coldPassResult(parts.map(p=>({part:p.part,runId:p.run_id,receipt:p.receipt})),s.parts.length):null
      const complete=coldResult?coldResult.status==='completed':parts.length===s.parts.length && parts.every(p=>['completed','no_evidence','unchanged'].includes(String(p.receipt?.status)))
      const last=coldResult?{run_id:coldResult.runId,receipt:parts.find(p=>p.run_id===coldResult.runId)?.receipt}:parts.at(-1)
      return {conceptId:s.concept.conceptId,title:s.concept.title,matchingChunks:s.matchingChunks,matchingMessages:s.matchingMessages,
        matchingTurns:s.matchingTurns,matchingCompleteTurns:s.matchingCompleteTurns,matchingUnpairedTurns:s.matchingUnpairedTurns,bankMatchingUnits:s.bankMatchingUnits,exhaustive:s.exhaustive,
        turns:s.turns.filter(t=>t.linkage==='explicit').length,unpaired:s.turns.filter(t=>t.linkage==='unpaired').length,messageCount:new Set(s.parts.flat()).size,
        batches:s.parts.length,status:coldResult?coldResult.status:complete?'completed':parts.some(p=>p.receipt && !['completed','no_evidence','unchanged'].includes(String(p.receipt.status)))?'failed':'pending',
        runs:parts.map(p=>({part:p.part,runId:p.run_id})),
        runId:last?.run_id??null,assessment:complete?(last?.receipt?.assessment??null):null,sourceExperimentId:runId,assessedAt:row.finished_at?.toISOString()??last?.receipt?.completedAt??null}
    })
    // Reuse baseline estimates visibly, never relabel them as newly assessed.
    const inherited=row.config.baseRunId?(await this.inspect(row.config.baseRunId,row.user_id)).items.filter(item=>!items.some(current=>current.conceptId===item.conceptId)):[]
    return {runId,label:`${row.config.datasetTag??'dev1'}: vector+turns`,status,createdAt:row.created_at.toISOString(),finishedAt:finishedAt?.toISOString()??null,
      config:{...row.config,concurrency:row.snapshot?.metadata.executionChanges?.at(-1)?.concurrency??row.config.concurrency},metadata:row.snapshot?{...row.snapshot.metadata,baseRunId:row.config.baseRunId??null,inheritedConceptIds:inherited.map(item=>item.conceptId)}:null,counts:row.snapshot?.counts??null,items:[...items,...inherited],
      durationMs:finishedAt?finishedAt.getTime()-row.created_at.getTime():null,
      unknownUsageCalls:results.filter(r=>r.receipt && !['no_evidence','unchanged'].includes(r.receipt.status) && (r.receipt.inputTokens===null || r.receipt.outputTokens===null)).length,
      pending:items.filter(i=>i.status==='pending').length,failed:items.filter(i=>i.status==='failed').length,
      inputTokens:results.reduce((n,r)=>n+Number(r.receipt?.inputTokens??0),0),outputTokens:results.reduce((n,r)=>n+Number(r.receipt?.outputTokens??0),0)}
  }
  async latest(userId:string,tag?:string) {
    const row=(await metaDbQuery<{run_id:string}>("SELECT run_id FROM learning_vector_turn_experiments WHERE user_id=$1 AND ($2::text IS NULL OR COALESCE(config->>'datasetTag','dev1')=$2) ORDER BY created_at DESC LIMIT 1",[userId,tag??null])).rows[0]
    return row ? this.inspect(row.run_id,userId):null
  }

  /** Read-only hook projection; never confuse experiment estimates with live cache. */
  async lookupAssessments(userId: string, graphs: LearningGraph[]) {
    const row = (await sql<{runId:string;baseRunId:string|null}>`SELECT run_id AS "runId",config->>'baseRunId' AS "baseRunId" FROM learning_vector_turn_experiments
      WHERE user_id=${userId} AND status='completed' AND COALESCE(config->>'purpose','experiment')='experiment' ORDER BY created_at DESC,run_id DESC LIMIT 1`.execute(this.db)).rows[0]
    const live=await this.assessments.list(userId)
    if (!row) return { experimentId: null, assessments: live }
    const lineage=[row.runId]
    let ancestor=row.baseRunId
    while(ancestor) {
      if(lineage.includes(ancestor)||lineage.length>=8) throw new Error('Invalid experiment lineage')
      lineage.push(ancestor)
      // Only the link: `row()` would also fetch the ~200 kB experiment snapshot.
      const parent=(await sql<{baseRunId:string|null}>`SELECT config->>'baseRunId' AS "baseRunId" FROM learning_vector_turn_experiments
        WHERE run_id=${ancestor} AND user_id=${userId}`.execute(this.db)).rows[0]
      if(!parent) throw new Error('Experiment not found')
      ancestor=parent.baseRunId
    }
    // Only final receipts and source IDs cross the DB boundary, never full transcripts. Small run
    // fields come from the digest: reading them out of the TOASTed snapshot cost ~1.6 s per turn.
    const rows = (await sql<{conceptId:string;runId:string;assessment:LearningConceptAssessment['assessment'];sourceIds:string[];nodeVersion:string;promptRevision:string;frozenConcept:AssessmentConcept}>`
      SELECT DISTINCT ON (a.concept_id) a.concept_id AS "conceptId",r.run_id AS "runId",
        t.receipt->'assessment' AS assessment,r.node_version AS "nodeVersion",d.prompt_revision AS "promptRevision",
        jsonb_build_object('conceptId',a.concept_id,'title',d.node_title,'description',d.node_description,'objectives',d.node_objectives) AS "frozenConcept",
        d.evidence_ids AS "sourceIds"
      FROM learning_concept_assessment_runs r JOIN learning_vector_turn_assessments a USING(run_id)
      JOIN learning_concept_assessment_run_digests d USING(run_id)
      JOIN learning_concept_assessment_receipts t USING(run_id)
      WHERE a.experiment_id IN (${sql.join(lineage.map(id=>sql`${id}::uuid`))}) AND r.user_id=${userId}
      ORDER BY a.concept_id,array_position(ARRAY[${sql.join(lineage.map(id=>sql`${id}::uuid`))}],a.experiment_id),a.part DESC`.execute(this.db)).rows
    const currentIds=new Set(graphs.flatMap(graph=>graph.concepts.map(concept=>concept.id)))
    const assessments = rows.filter(item=>item.assessment && currentIds.has(item.conceptId)).map(item=>({
      ...item,assessedAt:null,
      status:isCurrentAssessmentRevision(item.promptRevision) && item.assessment!.nodeVersion===item.nodeVersion && sameAssessmentConcept(item.frozenConcept,conceptFromGraphs(graphs,item.conceptId))?'ready' as const:'stale' as const,
    }))
    const liveIds=new Set(live.map(item=>item.conceptId))
    return {experimentId:row.runId,assessments:[...assessments.filter(item=>!liveIds.has(item.conceptId)),...live]}
  }
}

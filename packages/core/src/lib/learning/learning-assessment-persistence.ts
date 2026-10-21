import type { AssessmentConcept } from './learning-concept-assessment.js'
import type { GradualAssessmentProposal } from './learning-gradual-assessment.js'

/** One SQL statement checks canonical content and run ordering at the write boundary. */
export async function persistAssessmentCache(query: (text: string, params: ReadonlyArray<unknown>) => Promise<{ rowCount: number | null }>, input: {
  userId: string; concept: AssessmentConcept; nodeVersion: string; inputHash: string; runId: string; assessment: GradualAssessmentProposal; completedAt: string;
  admission?:{sessionId:string;dispatchId:string;runId:string}
}) {
  return query(`INSERT INTO learning_concept_assessment_cache(user_id,concept_id,node_version,input_hash,run_id,assessment,assessed_at)
    SELECT $1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz
    WHERE EXISTS(SELECT 1 FROM learning_concepts WHERE id=$2 AND title=$8 AND summary || E'\\n' || explanation=$9)
    AND COALESCE((SELECT jsonb_agg(DISTINCT goal ORDER BY goal) FROM learning_curriculum_module_concepts membership
      JOIN learning_curriculum_modules module ON module.curriculum_id=membership.curriculum_id AND module.id=membership.module_id
      CROSS JOIN LATERAL jsonb_array_elements_text(module.mastery_goals) goal WHERE membership.concept_id=$2),'[]'::jsonb)=$10::jsonb
    AND ($11::uuid IS NULL OR EXISTS(SELECT 1 FROM learning_reactive_admission WHERE user_id=$1 AND session_id=$11 AND dispatch_id=$12 AND run_id=$13))
    ON CONFLICT(user_id,concept_id) DO UPDATE SET node_version=EXCLUDED.node_version,input_hash=EXCLUDED.input_hash,
    run_id=EXCLUDED.run_id,assessment=EXCLUDED.assessment,assessed_at=EXCLUDED.assessed_at
    WHERE (SELECT created_at FROM learning_concept_assessment_runs WHERE run_id=learning_concept_assessment_cache.run_id)
      <= (SELECT created_at FROM learning_concept_assessment_runs WHERE run_id=EXCLUDED.run_id)`,
  [input.userId,input.concept.conceptId,input.nodeVersion,input.inputHash,input.runId,JSON.stringify(input.assessment),input.completedAt,input.concept.title,input.concept.description,JSON.stringify(input.concept.objectives),input.admission?.sessionId??null,input.admission?.dispatchId??null,input.admission?.runId??null])
}

import { z } from 'zod'
import { GradualAssessmentProposalSchema } from './learning-gradual-assessment.js'

/** Browser-safe public assessment contract; hashing and execution stay server-side. */
export const LearningConceptAssessmentSchema = z.object({
  conceptId:z.string(),assessment:GradualAssessmentProposalSchema.nullable(),runId:z.string().nullable(),
  status:z.enum(['unknown','pending','ready','stale']),assessedAt:z.string().nullable(),
})

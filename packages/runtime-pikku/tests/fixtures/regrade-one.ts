// A worker stand-in for the drift panel's restart test: regrades ONE panel item through the shipped grading service
// and the real LLM service (the `codex` CLI is CODEX_CLI_BIN, a fake), on LEARNER_DATABASE_URL. The test kills it
// mid-call.   bun regrade-one.ts <userId> <item> <week> <windowId>
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { bindDatabase, createDatabase } from '@learner/core/db/handle.js'
import { regradePanelItem } from '@learner/core/lib/learning/grader-drift-panel.js'
import { LocalVariablesService } from '@learner/core/runtime/types.js'
import { LearningConceptAssessmentService } from '@learner/core/services/learning-concept-assessment.js'
import { LearningCurriculumStore } from '@learner/core/services/learning-curriculum-store.js'
import { LLMService } from '@learner/llm/services/llm-service.js'

const [userId, item, week, windowId] = process.argv.slice(2)
bindDatabase(createDatabase(process.env.LEARNER_DATABASE_URL!, { max: 2, applicationName: 'learner-drift-standin' }))
const grader = new LearningConceptAssessmentService(Object.create(LearningCurriculumStore.prototype), new LLMService(new LocalVariablesService()))
console.log(JSON.stringify(await regradePanelItem(metaDbQuery, grader, { userId: userId!, item: Number(item), week: week!, windowId: Number(windowId) })))
process.exit(0)

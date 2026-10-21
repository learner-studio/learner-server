import { defineFunction } from '../../runtime/define.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import { ReactiveReadmitInput,ReactiveReadmitResult,readmitReactiveTargets } from '@learner/core/lib/learning/learning-reactive-consolidation.js'

/** The durable re-admission path for a whole-history regrade: marks every concept dirty through the admission
 * coalescer and returns. The paid work runs only as the dispatcher admits it, and stops at the admission pause. */
export const readmitLearningReactiveTargets=defineFunction({title:'Re-admit concepts for a fresh assessment pass over their whole history',expose:true,scopes:['admin'],input:ReactiveReadmitInput,output:ReactiveReadmitResult,
  func:async({locks,learningCurriculumStore},{requestId,conceptIds},{session})=>{
    assertLearningLocalMvpEnabled()
    return locks.withLock('learning-reactive','admission',()=>readmitReactiveTargets(session.userId,requestId,learningCurriculumStore,conceptIds))
  },
})

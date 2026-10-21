import { semanticIndexCoalescer } from './learning-archive-coordinator.js'

// One canonical local bank, not a learner identity. No caller-selected scope.
export const INDEX_SCOPE={userId:'canonical-index',sessionId:'00000000-0000-4000-8000-000000000001'}
export const indexCoalescer=semanticIndexCoalescer
export const markIndexDirty=(invocationId:string)=>indexCoalescer.markArchiveDirty(INDEX_SCOPE.userId,INDEX_SCOPE.sessionId,invocationId)

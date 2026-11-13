

export const HINDSIGHT_AGY_NATIVE_PILOT_STRATEGY = 'hindsight-agy-native-pilot-v1' as const

export type NativeRetainCheckpoint = {
  retainState?: string
  retainOperationId?: string
  retainRequestSha256?: string
}

/**
 * Reserve a paid native retain before transport. A crash after POST but before
 * the operation checkpoint deliberately leaves an uncertain reservation that
 * a replay will refuse instead of submitting the extraction again.
 */
export async function submitNativeRetainOnce(input: {
  checkpoint: NativeRetainCheckpoint
  requestSha256: string
  reserve: () => Promise<boolean>
  post: () => Promise<string>
  checkpointOperation: (operationId: string) => Promise<void>
  markUncertain: (message: string) => Promise<void>
}): Promise<{ operationId: string; replayed: boolean }> {
  if (input.checkpoint.retainOperationId) {
    if (input.checkpoint.retainRequestSha256 && input.checkpoint.retainRequestSha256 !== input.requestSha256) {
      throw new Error('Retain checkpoint request hash conflicts with the frozen request')
    }
    return { operationId: input.checkpoint.retainOperationId, replayed: true }
  }
  if (['reserved', 'uncertain'].includes(String(input.checkpoint.retainState))) {
    throw new Error('Retain is reserved or uncertain without an operation ID; refusing a duplicate native submit')
  }
  if (!await input.reserve()) throw new Error('Retain reservation was claimed concurrently; refusing a duplicate native submit')
  try {
    const operationId = await input.post()
    if (!operationId) throw new Error('Native retain omitted operation ID')
    await input.checkpointOperation(operationId)
    return { operationId, replayed: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try { await input.markUncertain(message) } catch { /* Preserve the original transport/checkpoint failure. */ }
    throw error
  }
}

export async function startPilotWorkflowOnce(input: {
  reserve: () => Promise<boolean>
  start: () => Promise<string>
  checkpointStarted: (workflowRunId: string) => Promise<void>
  markUncertain: (message: string) => Promise<void>
}): Promise<string> {
  if (!await input.reserve()) throw new Error('Native pilot workflow is already reserved, started, terminal, or not the frozen pilot')
  try {
    const workflowRunId = await input.start()
    await input.checkpointStarted(workflowRunId)
    return workflowRunId
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try { await input.markUncertain(message) } catch { /* Preserve the original start/checkpoint failure. */ }
    throw error
  }
}

export function assertCompletedBridgeCallAudit(calls: { callCount: number; completedCalls: number; failedCalls: number }): void {
  if (calls.callCount < 1 || calls.callCount > 5 || calls.failedCalls !== 0 || calls.completedCalls !== calls.callCount) {
    throw new Error(`Bridge call audit is not terminal-success within budget: calls=${calls.callCount} completed=${calls.completedCalls} failed=${calls.failedCalls}`)
  }
}

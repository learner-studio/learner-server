import type { CurriculumRunStatus } from './curriculum-generation-types.js'

/**
 * When a learner may approve an outline, and why the answer is not simply
 * "when the run is waiting".
 *
 * Approving starts the build, so the gate has to refuse a run that has nothing
 * to build from — approving one still outlining would infer a graph from a
 * null outline, and approving a completed one would rebuild a tree the learner
 * is already using.
 *
 * `failed` is the case worth stating. A build can die after the outline was
 * accepted: a model timeout, a validation the writer refused, a dispatch the
 * workflow rejected. The outline is still there and still approved-of, and
 * refusing to retry would strand the learner behind a failure that had nothing
 * to do with their decision. So a failed run with an outline is approvable
 * again, and a failed run without one is not — that one has to go back to the
 * beginning, because there is nothing to retry.
 */
export const canApproveRun = (
  status: CurriculumRunStatus,
  hasOutline: boolean,
): { readonly allowed: boolean; readonly reason: string } => {
  if (!hasOutline) return { allowed: false, reason: 'it has no outline to build from' }
  if (status === 'awaiting-approval') return { allowed: true, reason: '' }
  if (status === 'failed') return { allowed: true, reason: '' }
  return { allowed: false, reason: `it is ${status}, not awaiting approval` }
}

/**
 * When a run may be BUILT AGAIN from the outline it already has.
 *
 * Approval and rebuild are deliberately different questions, which is why this
 * is not a looser `canApproveRun`. Approval is the learner's decision about an
 * outline they have not yet accepted, so a completed run is refused there: it
 * would silently rewrite a tree they are already using. A rebuild is that same
 * rewrite asked for ON PURPOSE — the outline is unchanged and still theirs, and
 * what is regenerated is the layer beneath it, the concepts and the edges. That
 * is the operation you want after the concept generator itself changes: the
 * lessons stay put and the concepts hanging under them are written again.
 *
 * The refusals are the in-flight statuses. Two builds of one run write the same
 * curriculum id, and the write deletes the curriculum's own rows before
 * inserting, so a second build overlapping the first can delete rows the first
 * is still inserting against. A run with no outline has nothing to rebuild
 * FROM, exactly as with approval.
 */
export const canRebuildRun = (
  status: CurriculumRunStatus,
  hasOutline: boolean,
): { readonly allowed: boolean; readonly reason: string } => {
  if (!hasOutline) return { allowed: false, reason: 'it has no outline to build from' }
  if (status === 'completed') return { allowed: true, reason: '' }
  if (status === 'failed') return { allowed: true, reason: '' }
  if (status === 'awaiting-approval') {
    return { allowed: false, reason: 'it is still awaiting approval — approve it instead of rebuilding it' }
  }
  return { allowed: false, reason: `it is ${status}, and a second build would race the one in flight` }
}

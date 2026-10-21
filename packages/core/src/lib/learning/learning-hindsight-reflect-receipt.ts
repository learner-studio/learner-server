import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { gradualAssessmentPrompt, gradualAssessmentSchema, validateGradualAssessment, type GradualAssessmentContext } from './learning-gradual-assessment.js'

export function nativeReflectQuery(context: GradualAssessmentContext, nativeObservations: unknown, evidence: unknown): string {
  return [
    gradualAssessmentPrompt({ nodeStates: context.nodeStates, nativeObservations, evidence }),
    'Use the native memory tools as needed. Finish by calling done with answer containing ONLY the JSON object below: no Markdown fences, prose, or additional properties.',
    'The exact JSON Schema for the object inside done.answer follows. Do not convert nullable numbers or strings to stringified values.',
    JSON.stringify(gradualAssessmentSchema(context.nodeStates.map(node => node.conceptId))),
  ].join('\n\n')
}

export async function readOptionalPrivateJson(path: string): Promise<unknown | null> {
  let bytes: string
  try { bytes = await readFile(path, 'utf8') }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
  // A corrupt receipt is not an absent receipt and must not cause another call.
  return JSON.parse(bytes)
}

export async function writeImmutablePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

export function validateNativeReflectHttp(status: number, responseText: string, context: GradualAssessmentContext) {
  if (status < 200 || status >= 300) throw new Error(`Native reflect returned HTTP ${status}; raw response retained for review`)
  const response = z.object({ text: z.string() }).passthrough().parse(JSON.parse(responseText))
  return { response, proposals: validateGradualAssessment(JSON.parse(response.text), context) }
}

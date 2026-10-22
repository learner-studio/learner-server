import { RpcError, type RpcOutput } from '@learner/contract'
import type { BadgeTone } from '../../components/ui/badge'

/** The graph as `getLearningGraph` serves it; every Learning page reads its pieces from here. */
export type LearningGraph = RpcOutput<'getLearningGraph'>
export type Concept = LearningGraph['concepts'][number]
export type Mastery = Concept['mastery']
export type MasteryLevel = Mastery['level']
export type LearningModule = LearningGraph['curriculum']['modules'][number]
export type LearningLane = LearningGraph['curriculum']['lanes'][number]
export type ConversationHistory = RpcOutput<'getConversationHistory'>
export type ScopedAssessment = NonNullable<Concept['assessment']>

export const masteryLabel = (level: MasteryLevel): string => ({
  unknown: 'Unknown',
  exposed: 'Exposed',
  'partially-understood': 'Partially understood',
  operational: 'Operational',
  'well-understood': 'Well understood',
  uncertain: 'Uncertain',
}[level])

// Monochrome by design: mastery reads as a ramp of the neutral scale, with the
// two "look here" states (uncertain, partially understood) on the warning tone.
export const masteryTone = (level: MasteryLevel): BadgeTone =>
  level === 'partially-understood' || level === 'uncertain' ? 'warning' : level === 'unknown' || level === 'exposed' ? 'neutral' : 'accent'

export const percent = (value: number): string => `${Math.round(value * 100)}%`

export const dateTime = (value: string | number | null | undefined): string => {
  if (!value) return 'Not recorded'
  const text = String(value)
  const parsed = new Date(text)
  return Number.isNaN(parsed.valueOf()) ? text : parsed.toLocaleString()
}

/** An RPC failure as a sentence; an auth refusal says what to do about it. */
export const errorText = (error: unknown): string =>
  error instanceof RpcError && (error.status === 401 || error.status === 403) ? 'Sign in with an admin account to see this.' : error instanceof Error ? error.message : String(error)

/** The shell toggles `.dark` on <html>; canvas renderers that paint their own text follow it here. */
export function subscribeScheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}
export const currentScheme = (): 'light' | 'dark' => document.documentElement.classList.contains('dark') ? 'dark' : 'light'

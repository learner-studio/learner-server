import { createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * How learner-desktop's conversations and calls reach mastery scoring.
 *
 * Scoring reads only `learning_exposure_observations`, which the lossless
 * archive projects from transcript files. So each desktop document becomes a
 * Claude-format JSONL transcript in the spool `<uploadRoot>/desktop/<clientId>/<kind>/`,
 * registered as the `desktop-uploads` archive root. From there it follows
 * exactly the path a CLI transcript does: archive → observations → semantic
 * index → concept routing → assessment.
 *
 * - The learner's own words are `user` turns typed by a human. Everything else
 *   is an `assistant` turn: the AI in a chat export, and the other speakers in
 *   a call, prefixed with their name.
 * - Every row is stamped `entrypoint: "learner-desktop"` with a
 *   `/learner-desktop/<kind>` cwd, so desktop evidence stays distinguishable.
 * - The archive refuses a source whose captured prefix changes, so files are
 *   append-only. A document that grows only gains new lines. A document whose
 *   earlier turns changed gets a NEW file, a revision named by its digest. Turn
 *   ids hash the turn's own text, so an unchanged turn keeps its logical key
 *   and the observation ranking collapses the duplicate.
 */
export type DesktopTurn = { role: 'user' | 'assistant'; text: string; at: string }
export type DesktopTranscriptKind = 'chat' | 'call'

export const desktopSpoolRoot = (uploadRoot: string) => join(uploadRoot, 'desktop')

/** A stable RFC-4122-shaped id (version 5 bits) from arbitrary parts. */
export function stableUuid(...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('\u0000')).digest('hex')
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/**
 * A call's utterances, attributed on the device. Consecutive lines by one
 * speaker become one turn; the learner's are `user` turns, everyone else's are
 * `assistant` turns prefixed with their name.
 */
export function callTurns(utterances: readonly { speaker: string; text: string; at: string; learner: boolean }[]): DesktopTurn[] {
  const turns: (DesktopTurn & { speaker: string })[] = []
  for (const u of utterances) {
    const text = u.text.trim()
    if (!text) continue
    const last = turns.at(-1)
    if (last && last.speaker === u.speaker && (last.role === 'user') === u.learner) { last.text += `\n${text}`; continue }
    turns.push({ role: u.learner ? 'user' : 'assistant', speaker: u.speaker, text, at: u.at })
  }
  return turns.map(({ role, speaker, text, at }) => ({ role, at, text: role === 'user' ? text : `${speaker}: ${text}` }))
}

/** Claude-format transcript lines for one desktop document; ids are a pure function of the content. */
export function desktopTranscriptLines(clientId: string, kind: DesktopTranscriptKind, documentId: string, turns: readonly DesktopTurn[]): { sessionId: string; lines: string[] } {
  const sessionId = stableUuid('learner-desktop', clientId, kind, documentId)
  const uuids = turns.map((t, i) => stableUuid(sessionId, String(i), t.role, createHash('sha256').update(t.text).digest('hex')))
  // A chat reply answers the line before it. In a call the learner answers what
  // was said before, so those lines point FORWARD to the learner's next turn and
  // are graded with it; lines after the last learner turn keep the plain chain.
  const nextLearner = turns.map((_, i) => uuids[turns.findIndex((t, j) => j > i && t.role === 'user')] ?? null)
  const lines = turns.map((t, i) => {
    const uuid = uuids[i]!
    const previous = i ? uuids[i - 1]! : null
    const parentUuid = kind === 'call' && t.role === 'assistant' ? nextLearner[i] ?? previous : previous
    const common = { uuid, parentUuid, sessionId, timestamp: t.at, entrypoint: 'learner-desktop', cwd: `/learner-desktop/${kind}`, isSidechain: false }
    return JSON.stringify(t.role === 'user'
      ? { ...common, type: 'user', promptSource: 'typed', message: { role: 'user', content: t.text } }
      : { ...common, type: 'assistant', message: { id: uuid, role: 'assistant', content: [{ type: 'text', text: t.text }] } })
  })
  return { sessionId, lines }
}

/**
 * Write a document's transcript into the spool, append-only.
 * Returns `unchanged` when the spool already holds exactly these lines.
 */
// One writer per document at a time (the API is one process).
const writers = new Map<string, Promise<unknown>>()

export async function writeDesktopTranscript(uploadRoot: string, clientId: string, kind: DesktopTranscriptKind, documentId: string, turns: readonly DesktopTurn[]): Promise<{ file: string; status: 'created' | 'appended' | 'unchanged' | 'revised' }> {
  const key = `${clientId}/${kind}/${documentId}`
  const run = () => writeSerialized(uploadRoot, clientId, kind, documentId, turns)
  const next = (writers.get(key) ?? Promise.resolve()).then(run, run)
  writers.set(key, next.catch(() => undefined))
  return next
}

async function writeSerialized(uploadRoot: string, clientId: string, kind: DesktopTranscriptKind, documentId: string, turns: readonly DesktopTurn[]): Promise<{ file: string; status: 'created' | 'appended' | 'unchanged' | 'revised' }> {
  const { sessionId, lines } = desktopTranscriptLines(clientId, kind, documentId, turns)
  const dir = join(desktopSpoolRoot(uploadRoot), clientId, kind)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const body = lines.map((l) => `${l}\n`).join('')
  // The newest file for this document: the base file, or its latest revision.
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n === `${sessionId}.jsonl` || (n.startsWith(`${sessionId}.r`) && n.endsWith('.jsonl'))).sort()
  const current = names.at(-1)
  if (!current) {
    const file = join(dir, `${sessionId}.jsonl`)
    await atomicWrite(file, body)
    return { file, status: 'created' }
  }
  const file = join(dir, current)
  const held = await readFile(file, 'utf8')
  if (held === body) return { file, status: 'unchanged' }
  if (body.startsWith(held)) {
    const handle = await open(file, 'a', 0o600)
    try { await handle.appendFile(body.slice(held.length)); await handle.sync() } finally { await handle.close() }
    return { file, status: 'appended' }
  }
  // Earlier turns changed (or were dropped): never rewrite a captured prefix.
  const revision = join(dir, `${sessionId}.r${Date.now().toString(36)}-${createHash('sha256').update(body).digest('hex').slice(0, 12)}.jsonl`)
  await atomicWrite(revision, body)
  return { file: revision, status: 'revised' }
}

// Staged outside the archive root (same filesystem) so the sweep never captures a half-written file.
async function atomicWrite(file: string, body: string): Promise<void> {
  const staging = join(dirname(dirname(dirname(dirname(file)))), '.desktop-staging')
  await mkdir(staging, { recursive: true, mode: 0o700 })
  const tmp = join(staging, `${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
  await writeFile(tmp, body, { mode: 0o600 })
  await rename(tmp, file)
}

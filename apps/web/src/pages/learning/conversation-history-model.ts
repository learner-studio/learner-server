export type ConversationTurn = { id: string; exchangeId?: string; role: 'user' | 'assistant'; authorship: 'human' | 'agent' | 'system' | 'unknown'; authorshipEvidence: string; text: string; timestamp: string; model: string | null }
export type ConversationThread = { id: string; title: string; agent: string; provider: 'google' | 'anthropic' | 'openai'; location: 'local' | 'remote'; latestAt: string; models: string[]; workspacePath: string | null; folderSegments: string[]; turns: ConversationTurn[] }
export type FolderNode = { label: string; value: string; children?: FolderNode[] }
export const buildFolderTree = (threads: readonly ConversationThread[]): FolderNode[] => {
  const roots: FolderNode[] = [{ label: 'All conversations', value: '__all__' }, { label: 'Unscoped', value: '__unscoped__' }]
  const folders = new Map<string, FolderNode>()
  for (const thread of threads) {
    let parent: FolderNode | undefined
    let path = ''
    for (const segment of Array.isArray(thread.folderSegments) ? thread.folderSegments : []) {
      path += `/${segment}`
      let node = folders.get(path)
      if (!node) { node = { label: segment, value: path, children: [] }; folders.set(path, node); (parent?.children ?? roots).push(node) }
      parent = node
    }
  }
  const sort = (nodes: FolderNode[]) => { nodes.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })); nodes.forEach((node) => node.children && sort(node.children)) }
  const folderRoots = roots.slice(2)
  sort(folderRoots)
  return [roots[0]!, roots[1]!, ...folderRoots]
}
export const threadInFolder = (thread: ConversationThread, folder: string) => { const segments = Array.isArray(thread.folderSegments) ? thread.folderSegments : []; const threadPath = `/${segments.join('/')}`; return folder === '__all__' || (folder === '__unscoped__' ? segments.length === 0 : threadPath === folder || threadPath.startsWith(`${folder}/`)) }

export const shortDateTime = (value: string | number): string => {
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? String(value) : parsed.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export type ConversationExchange = {
  id: string
  meta: string
  at: number
  user: ConversationTurn
  assistant: ConversationTurn | null
}

/** One exchange = one user turn and the assistant turn that answered it, in the
 * same thread. The list is chronological across threads (oldest first), so a
 * reader follows the learner's questions in the order they were asked.
 *
 * Only exchanges the mastery pipeline can see are listed: the semantic index
 * admits a user turn only with `authorship === 'human'`, so agent-internal
 * prompts (harness instructions, subagent traffic, tool-driven calls whose
 * "reply" is an id) are excluded here for the same reason. */
/** Turn timestamps arrive as ISO strings from some providers and epoch numbers
 * from others; compare them as instants, never as strings. */
export const turnInstant = (value: string | number | null | undefined): number => {
  const parsed = new Date(value as string).valueOf()
  return Number.isNaN(parsed) ? 0 : parsed
}

export const conversationExchanges = (history: { threads: ConversationThread[] } | undefined): ConversationExchange[] =>
  (history?.threads ?? [])
    .flatMap((thread) => {
      const turns = [...thread.turns].sort((left, right) => turnInstant(left.timestamp) - turnInstant(right.timestamp))
      return turns.flatMap((turn, index) => {
        if (turn.role !== 'user' || turn.authorship !== 'human') return []
        // The API tags each turn with the exchange it belongs to; fall back to
        // "the next assistant turn before another question" for older payloads.
        const byExchange = turn.exchangeId ? turns.find((candidate) => candidate.role === 'assistant' && candidate.exchangeId === turn.exchangeId) : undefined
        const later = turns.slice(index + 1)
        const nextQuestion = later.findIndex((candidate) => candidate.role === 'user')
        const byAdjacency = later.slice(0, nextQuestion === -1 ? undefined : nextQuestion).find((candidate) => candidate.role === 'assistant')
        return [{
          id: `${thread.id}:${turn.id}`,
          meta: `${thread.agent} · ${thread.provider} · ${shortDateTime(turn.timestamp)}`,
          at: turnInstant(turn.timestamp),
          user: turn,
          assistant: byExchange ?? byAdjacency ?? null,
        }]
      })
    })
    .sort((left, right) => left.at - right.at)

export const collapseWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim()

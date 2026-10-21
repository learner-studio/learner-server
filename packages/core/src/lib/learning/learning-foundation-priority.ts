export type DependencyEdge = { from: string; to: string; kind: string }

/** Reorder eligible concepts only. Never expand the curriculum into the packet. */
export function foundationOrder(ids: string[], edges: DependencyEdge[]): string[] {
  const parents = new Map<string, Set<string>>()
  for (const edge of edges) if (edge.kind === 'hard-prerequisite') {
    if (!parents.has(edge.to)) parents.set(edge.to, new Set())
    parents.get(edge.to)!.add(edge.from)
  }
  const ancestors = new Map(ids.map(id => {
    const visited = new Set<string>()
    const pending = [...(parents.get(id) ?? [])]
    while (pending.length) {
      const next = pending.pop()!
      if (visited.has(next)) continue
      visited.add(next)
      pending.push(...(parents.get(next) ?? []))
    }
    return [id, visited] as const
  }))
  const remaining = new Set(ids)
  const ordered: string[] = []
  while (remaining.size) {
    // Ignore mutually reachable cycle edges: retain the incoming relevance order.
    const next = [...remaining].find(id => ![...remaining].some(other => other !== id
      && ancestors.get(id)!.has(other) && !ancestors.get(other)!.has(id))) ?? [...remaining][0]!
    ordered.push(next)
    remaining.delete(next)
  }
  return ordered
}

export const FOUNDATION_GUIDANCE = 'Concepts follow prerequisite-to-dependent understanding order where known; unrelated concepts retain relevance order. Dependencies are advisory, not proof of a learning deficit. Answer the current task first. Emphasize at most one useful foundational concept and optionally one connected concept, explaining their relation to the task. Two concepts is a ceiling, not a quota. Ask at most one brief understanding probe when useful; do not force a lesson or withhold the answer.'

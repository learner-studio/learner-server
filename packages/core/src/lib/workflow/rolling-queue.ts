/** Native queue workers fetch one job per slot; a slow job never gates siblings. */
export const rollingQueueConfig = (ceiling: number) => ({
  batchSize: ceiling,
  pollInterval: 1000,
  groupConcurrency: {
    default: 1,
    tiers: Object.fromEntries(Array.from({ length: ceiling }, (_, i) => [String(i + 1), i + 1])),
  },
})

export const rollingConcepts = (batches: Array<Array<{ conceptId: string; part: number }>>) => {
  const concepts = new Map<string, Set<number>>()
  for (const item of batches.flat()) {
    const parts = concepts.get(item.conceptId) ?? new Set<number>()
    parts.add(item.part)
    concepts.set(item.conceptId, parts)
  }
  return [...concepts].map(([conceptId, parts]) => ({ conceptId, parts: [...parts].sort((a, b) => a - b) }))
}

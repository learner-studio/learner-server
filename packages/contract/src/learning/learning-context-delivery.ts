/** One Learning context contract; transport adapters must never rewrite its policy.
 * Claude's 10,000-character per-hook limit is a delivery limit, not a token budget.
 */
export const LEARNING_CONTEXT_PART_LIMIT = 8000
export type LearningCli = 'claude' | 'codex' | 'agy'

export function learningContextParts(context: string, label = 'Learning context'): string[] {
  if (!context) return []
  // Leave room for a self-identifying header. Preserve every source character.
  const chunks: string[] = []
  let remaining = context
  while (remaining.length) {
    let end = Math.min(7600, remaining.length)
    if (end < remaining.length) {
      const newline = remaining.lastIndexOf('\n', end - 1)
      if (newline >= 0) end = newline + 1
    }
    if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1]!)) end--
    chunks.push(remaining.slice(0, end))
    remaining = remaining.slice(end)
  }
  if (label.length > 200) throw new Error('Learning context label too long')
  return chunks.map((chunk, index) => `[${label}; part ${index + 1}/${chunks.length}]\n${chunk}`)
}

/** One envelope PER registered hook, not an array stuffed into additionalContext. */
export function learningNativeHookOutput(provider: 'claude' | 'codex', context: string) {
  if (!['claude', 'codex'].includes(provider)) throw new Error('Native Learning hooks unsupported for this provider')
  if (!context) return {}
  if (context.length > LEARNING_CONTEXT_PART_LIMIT) throw new Error('Learning context exceeds inline hook budget')
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit' as const, additionalContext: context } }
}

/** Harness path: all CLIs use runCliAgent's existing provider-specific stdin encoder.
 * AGY has no assumed Claude-style native hook. Its context enters the prompt.
 */
export function learningCliPrompt(context: string, message: string) {
  return context ? `LEARNING CONTEXT:\n${context}\n\nEND LEARNING CONTEXT\n\nCURRENT USER REQUEST:\n${message}` : message
}

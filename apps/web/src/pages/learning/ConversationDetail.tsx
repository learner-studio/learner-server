import { Badge } from '../../components/ui/badge'
import { Card } from '../../components/ui/card'
import type { ConversationThread } from './conversation-history-model'

/** The selected thread's turns, oldest first, each with the provenance its authorship was read from. */
export default function ConversationDetail({ thread }: { readonly thread?: ConversationThread }) {
  if (!thread) return <p className="m-0 text-sm text-ink-soft">Select a conversation to read its turns.</p>
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <strong className="block">Selected conversation</strong>
          <span className="block truncate text-sm text-ink-soft">{thread.agent} · {thread.workspacePath ?? 'Unscoped'}</span>
        </div>
        <Badge>{thread.location}</Badge>
      </div>
      <div className="flex max-h-[420px] flex-col gap-2 overflow-auto pr-1">
        {[...thread.turns].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).map((turn) => (
          <Card inset key={turn.id}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex gap-1.5">
                <Badge variant="solid" tone={turn.role === 'user' ? 'warning' : 'neutral'}>{turn.role}</Badge>
                <Badge tone={turn.authorship === 'human' ? 'success' : turn.authorship === 'agent' ? 'accent' : 'neutral'}>{turn.authorship}</Badge>
              </div>
              <span className="text-xs text-ink-soft">{new Date(turn.timestamp).toLocaleString()}</span>
            </div>
            <p className="m-0 mt-1 text-xs text-ink-soft">{turn.authorshipEvidence}</p>
            <p className="m-0 mt-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{turn.text}</p>
          </Card>
        ))}
      </div>
    </div>
  )
}

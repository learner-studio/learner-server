import { useMemo, useState } from 'react'
import { Badge } from '../../components/ui/badge'
import { Input } from '../../components/ui/input'
import { cn } from '../../lib/utils'
import type { ConversationThread } from './conversation-history-model'

export function ConversationThreadRow({ thread, selected, onSelect }: { readonly thread: ConversationThread; readonly selected: boolean; readonly onSelect: (id: string) => void }) {
  return (
    <button type="button" data-conversation-thread-row data-selected={selected} aria-pressed={selected} onClick={() => onSelect(thread.id)}
      className={cn('flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition', selected ? 'bg-glass-strong text-ink' : 'text-ink-soft hover:bg-glass hover:text-ink')}>
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        <span className="max-w-full truncate text-sm font-semibold">{thread.title}</span>
        <Badge aria-label={thread.provider === 'google' ? 'Google' : thread.provider === 'openai' ? 'OpenAI' : 'Claude'}>{thread.provider}</Badge>
        {(thread.models.length ? thread.models : ['Model unknown']).map((model) => <Badge key={model} variant="outline">{model}</Badge>)}
        <Badge tone={thread.location === 'remote' ? 'accent' : 'success'}>{thread.location === 'remote' ? 'Remote' : 'Local'}</Badge>
      </span>
      <span className="text-xs text-ink-soft">{thread.turns.length}</span>
    </button>
  )
}

export default function ConversationThreadList({ threads, selected, onSelect }: { readonly threads: readonly ConversationThread[]; readonly selected: string; readonly onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const shown = useMemo(() => threads.filter((t) => `${t.title} ${t.agent}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => String(b.latestAt).localeCompare(String(a.latestAt))), [threads, query])
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <Input aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
      <span className="text-sm text-ink-soft">{shown.length} conversations</span>
      <div className="flex min-h-0 flex-col gap-0.5 overflow-auto">
        {shown.map((thread) => <ConversationThreadRow key={thread.id} thread={thread} selected={selected === thread.id} onSelect={onSelect} />)}
      </div>
    </div>
  )
}

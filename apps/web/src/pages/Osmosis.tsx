import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RpcError } from '@learner/contract'
import { Button } from '../components/ui/button'
import { GlassPanel, LearnerBackdrop, PageHead } from '../components/glass'
import { useRpcMutation, useRpcQuery } from '../lib/api'
import { LEARNER_HOME } from '../lib/routes'
import { cn } from '../lib/utils'
import { OsmosisNav } from './learning/OsmosisNav'

/**
 * Osmosis: the live state of the Learning loop — whether every CLI session's
 * hook is reporting, how much of the conversation archive is indexed, and the
 * concept catalog the hook classifies against. All three are server RPCs.
 */
const errorText = (error: unknown) =>
  error instanceof RpcError && (error.status === 401 || error.status === 403) ? 'Sign in with an admin account to see this.' : error instanceof Error ? error.message : String(error)

function HookHealth() {
  const query = useRpcQuery('getLearningHookHealth', { windowMinutes: 30 }, { refetchInterval: 30_000 })
  const health = query.data
  const tone = query.error ? 'bg-amber-500' : health?.status === 'ok' ? 'bg-emerald-500' : health?.status === 'warning' ? 'bg-amber-500' : health ? 'bg-rose-500' : 'bg-slate-400'
  const live = health?.sessions.filter((s) => s.state === 'live').length ?? 0
  return (
    <GlassPanel data-testid="learning-hook-health" className="flex items-start gap-4 rounded-[14px] px-6.5 py-5.5">
      <span className={cn('mt-1.5 size-3 flex-none rounded-full', tone)} aria-hidden />
      <div className="min-w-0">
        <strong className="block text-[15px] font-semibold">CLI hook</strong>
        {query.isLoading && <span className="text-sm text-ink-soft">Checking sessions…</span>}
        {query.error && <span className="text-sm text-ink-soft">{errorText(query.error)}</span>}
        {health && <span className="text-sm text-ink-soft">{health.status === 'ok' ? 'Every CLI session is reporting.' : `${live} of ${health.sessions.length} CLI sessions live in the last ${health.windowMinutes} min.`}</span>}
        {health && health.messages.length > 0 && <ul className="mt-2 list-disc pl-5 text-sm text-ink-soft">{health.messages.map((m) => <li key={m}>{m}</li>)}</ul>}
      </div>
    </GlassPanel>
  )
}

function IndexStatus() {
  const status = useRpcQuery('getLearningIndexStatus', {}, { refetchInterval: 5000 })
  const start = useRpcMutation('startLearningIndex')
  const s = status.data
  return (
    <GlassPanel data-testid="learning-index-status" className="flex flex-col gap-2 px-6.5 py-5.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2"><h3 className="m-0 text-[15px] font-semibold">Local conversation index</h3><span className="rounded-full bg-glass-strong px-2 py-0.5 text-xs text-ink-soft">{s?.model ?? 'BGE local'}</span></div>
        <Button variant="secondary" size="sm" disabled={start.isPending || s?.runStatus === 'running' || !s} onClick={() => start.mutate({}, { onSuccess: () => void status.refetch() })}>Sync archive</Button>
      </div>
      {status.isLoading && <p className="m-0 text-sm text-ink-soft">Checking index…</p>}
      {s && <>
        <p className="m-0 text-sm">{s.indexedMessages.toLocaleString()} indexed messages · {s.indexedChunks.toLocaleString()} chunks · {s.pendingMessages.toLocaleString()} pending · {s.errorMessages.toLocaleString()} errors</p>
        <p className="m-0 text-xs text-ink-soft">{s.bank} · last indexed {s.latestIndexedAt ?? 'never'} · background sync {s.scheduleEnabled ? 'enabled' : 'gated'}</p>
        {s.limitations.map((item) => <p key={item} className="m-0 text-xs text-ink-soft">{item}</p>)}
      </>}
      {(status.error || start.error) && <p className="m-0 text-sm text-rose-600 dark:text-rose-400">{errorText(status.error ?? start.error)}</p>}
    </GlassPanel>
  )
}

function Catalog() {
  const query = useRpcQuery('getLearningFeedbackCatalog', {})
  const [filter, setFilter] = useState('')
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return (query.data?.catalog ?? []).filter((c) => !needle || c.title.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle))
  }, [query.data, filter])
  return (
    <GlassPanel data-testid="learning-catalog" className="flex flex-col gap-3 px-6.5 py-5.5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="m-0 text-[15px] font-semibold">Concept catalog {query.data && <span className="font-normal text-ink-soft">· {query.data.catalog.length} concepts · {query.data.catalogVersion.slice(0, 12)}</span>}</h3>
        <input aria-label="Filter concepts" placeholder="Filter concepts" value={filter} onChange={(e) => setFilter(e.target.value)}
          className="w-full rounded-lg border border-glass-border bg-glass-strong px-3 py-1.5 text-sm text-ink outline-none placeholder:text-ink-soft focus:border-accent md:w-64" />
      </div>
      {query.isLoading && <p className="m-0 text-sm text-ink-soft">Loading catalog…</p>}
      {query.error && <p className="m-0 text-sm text-ink-soft">{errorText(query.error)}</p>}
      {query.data && (
        <ul className="m-0 grid max-h-[420px] list-none grid-cols-1 gap-x-6 gap-y-1 overflow-auto p-0 text-sm md:grid-cols-2">
          {shown.map((c) => <li key={c.id} className="truncate" title={c.id}><span>{c.title}</span> <span className="text-xs text-ink-soft">{c.id}</span></li>)}
          {shown.length === 0 && <li className="text-ink-soft">No concept matches “{filter}”.</li>}
        </ul>
      )}
    </GlassPanel>
  )
}

export default function LearnerOsmosisPage() {
  const navigate = useNavigate()
  return (
    <LearnerBackdrop>
      <OsmosisNav />
      <PageHead title="Osmosis" onHome={() => navigate(LEARNER_HOME)}>Micro-lessons ride along inside your AI conversations. This is the live state of that loop: the hook in every CLI session, the indexed conversation archive, and the catalog every turn is classified against.</PageHead>
      <HookHealth />
      <IndexStatus />
      <Catalog />
    </LearnerBackdrop>
  )
}

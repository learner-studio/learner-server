import { Card, Eyebrow } from '../../components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover'
import { Progress } from '../../components/ui/progress'
import { ConceptAssessment } from './ConceptAssessment'
import { collapseWhitespace, conversationExchanges, type ConversationExchange, type ConversationThread } from './conversation-history-model'
import { dateTime, percent, type Concept, type ConversationHistory, type Mastery } from './learning-model'

const confidenceLabel = (mastery: Mastery): string => {
  if (mastery.confidence <= 0) return 'Not established'
  return `${percent(mastery.confidence)} (${percent(mastery.interval.low)}–${percent(mastery.interval.high)})`
}

const Role = ({ children }: { readonly children: string }) => <span className="mr-1.5 font-bold text-ink">{children}</span>

/** One row per exchange. The row itself stays two truncated lines so the panel
 * never grows; the expander pops the full exchange up in a popover instead. */
function ExchangeCard({ exchange }: { readonly exchange: ConversationExchange }) {
  const userText = collapseWhitespace(exchange.user.text)
  const assistantText = exchange.assistant ? collapseWhitespace(exchange.assistant.text) : 'No reply recorded'
  return (
    <div className="rounded-lg border border-glass-border bg-glass px-2 py-1.5" data-testid="conversation-exchange">
      <div className="flex items-center justify-between gap-1">
        <span className="truncate text-xs text-ink-soft">{exchange.meta}</span>
        <Popover>
          <PopoverTrigger aria-label="Show full exchange" className="cursor-pointer rounded px-1 text-xs text-ink-soft hover:bg-glass-strong hover:text-ink">⤢</PopoverTrigger>
          <PopoverContent side="left" align="start" className="w-[min(520px,calc(100vw-24px))] max-h-[min(60vh,480px)]" data-testid="conversation-exchange-detail">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-soft">{exchange.meta}</span>
              <p className="m-0 text-sm whitespace-pre-wrap"><Role>You</Role>{exchange.user.text.trim()}</p>
              <p className="m-0 text-sm whitespace-pre-wrap text-ink-soft"><Role>Agent</Role>{exchange.assistant ? exchange.assistant.text.trim() : 'No reply recorded'}</p>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <div className="flex gap-2">
        <div className="flex flex-col items-center py-1" aria-hidden="true">
          <span className="exchange-dot bg-accent" />
          <span className="exchange-edge" />
          <span className="exchange-dot bg-ink-soft" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="m-0 truncate text-xs" title={userText} data-role="user"><Role>You</Role>{userText}</p>
          <p className="m-0 truncate text-xs text-ink-soft" title={assistantText} data-role="assistant"><Role>Agent</Role>{assistantText}</p>
        </div>
      </div>
    </div>
  )
}

const Stat = ({ label, children }: { readonly label: string; readonly children: React.ReactNode }) => (
  <div className="flex min-w-0 flex-col gap-0.5"><Eyebrow>{label}</Eyebrow><span className="text-sm font-bold">{children}</span></div>
)

export function ConceptInspector({ concept, history, historyLoading = false, experimentScoped = false, evidenceRuns }: {
  readonly concept: Concept | undefined
  readonly history: ConversationHistory | undefined
  readonly historyLoading?: boolean
  readonly experimentScoped?: boolean
  readonly evidenceRuns?: readonly { part: number; runId: string }[]
}) {
  if (!concept) {
    return <Card inset><p className="m-0 text-sm text-ink-soft">Choose a curriculum step or graph node to inspect mastery, evidence, and review status.</p></Card>
  }

  const mastery = concept.mastery
  const exchanges = conversationExchanges(history as { threads: ConversationThread[] } | undefined)

  return (
    <Card inset aria-live="polite" data-testid="concept-inspector" data-concept-id={concept.id}>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-12">
        <div className="md:col-span-7">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Assessment confidence">
              {confidenceLabel(mastery)}
              {mastery.level !== 'unknown' && <Progress className="mt-1" value={mastery.score * 100} tone={mastery.level === 'partially-understood' || mastery.level === 'uncertain' ? 'warning' : 'accent'} aria-label="Mastery estimate" />}
            </Stat>
            <Stat label="Evidence">{mastery.evidenceCount} recorded</Stat>
            <Stat label="Last retrieval">{dateTime(mastery.lastRetrievalAt)}</Stat>
            <Stat label="Next review">{dateTime(mastery.nextReviewAt)}</Stat>
          </div>
          <ConceptAssessment key={`${concept.id}:${concept.assessment?.runId ?? 'none'}:${experimentScoped}`} conceptId={concept.id} evidenceRuns={evidenceRuns}
            scoped={experimentScoped ? concept.assessment ?? { conceptId: concept.id, assessment: null, runId: null, status: 'unknown', assessedAt: null } : undefined} />
        </div>
        <div className="flex min-h-0 flex-col gap-1.5 md:col-span-5" data-testid="concept-conversations">
          <div className="flex items-baseline justify-between">
            <Eyebrow>Conversations · {exchanges.length} exchange{exchanges.length === 1 ? '' : 's'}</Eyebrow>
            <span className="text-xs text-ink-soft">oldest first</span>
          </div>
          <div className="max-h-80 overflow-auto">
            {historyLoading && <p className="m-0 p-2 text-xs text-ink-soft">Loading conversations…</p>}
            {!historyLoading && exchanges.length === 0 && <p className="m-0 p-2 text-xs text-ink-soft">No conversations match this concept yet.</p>}
            <div className="flex flex-col gap-1 p-1">
              {exchanges.map((exchange) => <ExchangeCard key={exchange.id} exchange={exchange} />)}
            </div>
          </div>
        </div>
      </div>
    </Card>
  )
}

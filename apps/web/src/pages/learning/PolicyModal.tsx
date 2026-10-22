import { useEffect, useState } from 'react'
import type { RpcOutput } from '@learner/contract'
import { Alert } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Dialog } from '../../components/ui/dialog'
import { Field, Select } from '../../components/ui/input'
import { Spinner } from '../../components/ui/progress'
import { Slider } from '../../components/ui/slider'
import { Switch } from '../../components/ui/switch'
import { useRpcMutation, useRpcQuery } from '../../lib/api'
import { errorText } from './learning-model'
import { SemanticIndexStatus } from './SemanticIndexStatus'
import { VectorExperiment } from './VectorExperiment'

type LearningPolicySettings = {
  injectionRate: number
  progressionLinearity: number
  reviewUrgency: number
  taskRelevance: number
  misconceptionPriority: number
  frontierPull: number
  uncertaintyProbing: number
  repetitionAvoidance: number
  transferDepth: number
}

type ExtractorSelection = Pick<RpcOutput<'getLearningExtractorConfig'>, 'backend' | 'model' | 'effort'>

const DEFAULT_EXTRACTOR_SELECTION: ExtractorSelection = { backend: 'agy', model: 'gemini-3.7-flash', effort: 'high' }

const extractorModelKey = (backend: string, model: string): string => `${backend}:${model}`

const DEFAULT_POLICY_SETTINGS: LearningPolicySettings = {
  injectionRate: 40,
  progressionLinearity: 60,
  reviewUrgency: 40,
  taskRelevance: 80,
  misconceptionPriority: 80,
  frontierPull: 40,
  uncertaintyProbing: 40,
  repetitionAvoidance: 60,
  transferDepth: 60,
}

const POLICY_WEIGHTS: Array<{
  key: Exclude<keyof LearningPolicySettings, 'injectionRate'>
  label: string
  description: string
  low: string
  high: string
}> = [
  { key: 'progressionLinearity', label: 'Prerequisite strictness', description: 'How strongly hard-prerequisite edges constrain what the agent may introduce next.', low: 'Soft context', high: 'Hard gate' },
  { key: 'reviewUrgency', label: 'Spaced-repetition urgency', description: 'How strongly an approaching or overdue nextReviewAt promotes a concept into the current turn.', low: 'Wait for relevance', high: 'Act near due date' },
  { key: 'taskRelevance', label: 'Current-task relevance', description: 'How much topical relevance must outweigh globally useful but potentially distracting instruction.', low: 'Allow detours', high: 'Stay on task' },
  { key: 'misconceptionPriority', label: 'Misconception correction', description: 'How aggressively a confident contradiction should outrank review and forward progression.', low: 'Defer correction', high: 'Correct blockers' },
  { key: 'frontierPull', label: 'Frontier progression', description: 'How strongly the next ready concept is favored once its prerequisites appear understood.', low: 'Consolidate', high: 'Advance' },
  { key: 'uncertaintyProbing', label: 'Assessment uncertainty', description: 'How readily the agent asks a short probe when learner-state evidence is sparse or contradictory.', low: 'Assume and continue', high: 'Resolve uncertainty' },
  { key: 'repetitionAvoidance', label: 'Repetition avoidance', description: 'How strongly recent concepts and unanswered interventions are penalized during selection.', low: 'Repeat freely', high: 'Prefer novelty' },
  { key: 'transferDepth', label: 'Transfer and mental models', description: 'How strongly novel application, prediction, and comparison are favored over recognition or recall.', low: 'Recognition', high: 'Conceptual transfer' },
]

/** The extractor model is live configuration; everything below it is a front-end preview of the future policy service. */
export function LearningPolicySettingsModal({ opened, onClose }: { readonly opened: boolean; readonly onClose: () => void }) {
  const [settings, setSettings] = useState<LearningPolicySettings>(DEFAULT_POLICY_SETTINGS)
  const [extractorSelection, setExtractorSelection] = useState<ExtractorSelection>(DEFAULT_EXTRACTOR_SELECTION)
  const [modelSaved, setModelSaved] = useState(false)
  const modelCatalogQuery = useRpcQuery('listModelCatalog', {}, { enabled: opened })
  const extractorConfigQuery = useRpcQuery('getLearningExtractorConfig', {}, { enabled: opened })
  const saveExtractorConfig = useRpcMutation('saveLearningExtractorConfigFunction')
  const catalogModels = modelCatalogQuery.data?.models ?? []
  const selectedModel = catalogModels.find((entry) => entry.backend === extractorSelection.backend && entry.id === extractorSelection.model)

  useEffect(() => {
    const config = extractorConfigQuery.data
    if (!config) return
    setExtractorSelection({ backend: config.backend, model: config.model, effort: config.effort })
  }, [extractorConfigQuery.data])

  const setWeight = (key: keyof LearningPolicySettings, value: number) => setSettings((current) => ({ ...current, [key]: value }))
  const saveModelSelection = async () => {
    setModelSaved(false)
    const saved = await saveExtractorConfig.mutateAsync(extractorSelection).catch(() => null)
    if (!saved) return
    setExtractorSelection({ backend: saved.backend, model: saved.model, effort: saved.effort })
    setModelSaved(true)
  }
  const configError = modelCatalogQuery.error ?? extractorConfigQuery.error ?? saveExtractorConfig.error

  return (
    <Dialog open={opened} onOpenChange={(open) => { if (!open) onClose() }} title="Learning intervention policy" className="max-w-4xl">
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-2" data-testid="learning-data-section">
          <div>
            <strong className="block">Archive data</strong>
            <p className="m-0 text-sm text-ink-soft">Your CLI archive is indexed locally, then assessed against the curriculum. Both run in the background; use these to check on them or trigger a run.</p>
          </div>
          {opened && <SemanticIndexStatus />}
          {opened && <VectorExperiment />}
        </section>

        <Card inset className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <strong className="block">Extractor model</strong>
              <p className="m-0 text-sm text-ink-soft">This is the live model identity the Learning extractor will read at call time. Available combinations come from the server’s CLI-probed model catalogue.</p>
            </div>
            <Badge tone="accent">Server configured</Badge>
          </div>
          {modelCatalogQuery.isPending || extractorConfigQuery.isPending ? (
            <div className="flex items-center gap-2 text-sm"><Spinner />Loading CLI models…</div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="CLI and model">
                <Select
                  value={extractorModelKey(extractorSelection.backend, extractorSelection.model)}
                  options={catalogModels.map((entry) => ({ value: extractorModelKey(entry.backend, entry.id), label: `${entry.label} · ${entry.backend}`, disabled: entry.unavailable }))}
                  onChange={(event) => {
                    const entry = catalogModels.find((candidate) => extractorModelKey(candidate.backend, candidate.id) === event.target.value)
                    if (!entry) return
                    setModelSaved(false)
                    setExtractorSelection({ backend: entry.backend, model: entry.id, effort: entry.defaultEffort })
                  }}
                />
              </Field>
              <Field label="Reasoning effort">
                <Select
                  value={extractorSelection.effort}
                  options={(selectedModel?.efforts ?? []).map((entry) => ({ value: entry.effort, label: entry.selectable ? entry.effort : `${entry.effort} · unavailable`, disabled: !entry.selectable }))}
                  onChange={(event) => {
                    const effort = selectedModel?.efforts.find((entry) => entry.effort === event.target.value && entry.selectable)?.effort
                    if (!effort) return
                    setModelSaved(false)
                    setExtractorSelection((current) => ({ ...current, effort }))
                  }}
                />
              </Field>
            </div>
          )}
          {configError && <Alert tone="danger" title="Extractor configuration unavailable">{errorText(configError)}</Alert>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-ink-soft">{extractorSelection.backend} / {extractorSelection.model} / {extractorSelection.effort}</span>
            <div className="flex items-center gap-2">
              {modelSaved && <Badge tone="success">Saved</Badge>}
              <Button size="sm" disabled={saveExtractorConfig.isPending || !selectedModel || selectedModel.unavailable} onClick={() => void saveModelSelection()}>
                {saveExtractorConfig.isPending && <Spinner className="size-3" />}Save extractor model
              </Button>
            </div>
          </div>
        </Card>

        <Alert title="Interactive policy preview">The intervention controls below remain a front-end mock. They preview how the future context service will rank learning interventions; these weights are not persisted and do not yet change agent responses.</Alert>

        <Card inset className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <strong className="block">Injection rate</strong>
              <p className="m-0 text-sm text-ink-soft">The maximum appetite for adding one learning intervention to an otherwise normal agent turn. Zero disables injections; 100% permits them whenever the policy finds sufficient value. It is a ceiling, not a random percentage of turns.</p>
            </div>
            <Badge variant="solid" tone={settings.injectionRate === 0 ? 'neutral' : 'accent'}>{settings.injectionRate}%</Badge>
          </div>
          <Slider label="Injection rate" value={settings.injectionRate} onValueChange={(value) => setWeight('injectionRate', value)} step={20} />
          <div className="flex justify-between text-[11px] text-ink-soft">{[0, 20, 40, 60, 80, 100].map((mark) => <span key={mark}>{mark}%</span>)}</div>
        </Card>

        <Card inset className="flex flex-col gap-2" data-testid="learning-understanding-check-setting">
          <div className="flex items-center justify-between gap-2">
            <strong>Understanding checks</strong>
            <Badge>Planned · not active</Badge>
          </div>
          <Switch checked={false} disabled label="Require understanding check with every message"
            description="Future prompt-experiment setting: ask one lightweight, task-related prediction, explanation, or choice question with each response. Not connected to the agent yet; tune the core prompt first." />
        </Card>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <strong className="block">Intervention ranking weights</strong>
            <p className="m-0 text-sm text-ink-soft">These weights rank eligible teaching moves after the injection ceiling and hard safety rules are applied.</p>
          </div>
          <Switch checked={false} disabled label="Auto-tune from outcomes · upcoming" />
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {POLICY_WEIGHTS.map((weight) => (
            <Card inset key={weight.key} className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <strong className="text-sm">{weight.label}</strong>
                <Badge>{settings[weight.key]}%</Badge>
              </div>
              <p className="m-0 min-h-9 text-xs text-ink-soft">{weight.description}</p>
              <Slider label={weight.label} value={settings[weight.key]} onValueChange={(value) => setWeight(weight.key, value)} step={20} />
              <div className="flex justify-between gap-2 text-xs text-ink-soft"><span>{weight.low}</span><span className="text-right">{weight.high}</span></div>
            </Card>
          ))}
        </div>

        <p className="m-0 rounded-lg bg-glass p-3 text-xs text-ink-soft">Future adaptive tuning can learn from unnecessary-intervention rate, repeated questions, learner dismissals, delayed retrieval, transfer success, retention intervals, and task completion—but deterministic safety and task-preservation rules remain hard constraints.</p>

        <div className="flex justify-between">
          <Button variant="secondary" size="md" onClick={() => setSettings(DEFAULT_POLICY_SETTINGS)}>Reset preview</Button>
          <Button size="md" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Dialog>
  )
}

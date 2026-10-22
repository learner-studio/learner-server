import { createHash } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ExposureObservation } from '@learner/core/lib/learning/learning-exposure-schemas.js'
import { LearningExposureService } from '@learner/core/services/learning-exposure-service.js'
import { openLearnerDatabase, usage } from './_db.js'

const EXPERIMENT_ROOT = '/var/lib/learner/learning-experiments/'

type CanonicalItem = Awaited<ReturnType<LearningExposureService['query']>>['items'][number]
type Group = { users: Map<string, CanonicalItem>; agents: CanonicalItem[] }

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const text = (item: CanonicalItem) => item.observation.parts
  .filter(part => part.type === 'text').map(part => part.text ?? '').join('\n')
const omitted = (item: CanonicalItem) => item.observation.parts.some(part => part.textOmitted)
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

const parse = () => {
  const args = process.argv.slice(2)
  const value = (name: string) => {
    const index = args.indexOf(name)
    return index < 0 ? undefined : args[index + 1]
  }
  usage(`
Usage: bun --env-file=/etc/learner/db.env scripts/learning/hindsight-cohort.ts --pair-count N --output ${EXPERIMENT_ROOT}<name>.json [--label TEXT]
Selects the latest N exact human/final-answer exposure pairs (double-scanned for
stability, refetched by logical key) and writes a frozen cohort manifest with
transcript text (mode 600). Reads the learner database only.`)
  const pairCount = Number(value('--pair-count') ?? '0')
  const output = value('--output')
  const label = value('--label') ?? `Hindsight canonical pilot ${pairCount}`
  if (!Number.isSafeInteger(pairCount) || pairCount < 1 || pairCount > 500) throw new Error('pair-count must be 1..500')
  if (!output?.startsWith(EXPERIMENT_ROOT)) throw new Error(`output must be under the private experiment root ${EXPERIMENT_ROOT}`)
  return { pairCount, output, label }
}

const scan = async (service: LearningExposureService, cutoff: string) => {
  const items: CanonicalItem[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    const page = await service.query({ limit: 100, cursor, includeUnknown: false })
    items.push(...page.items.filter(item => item.observation.observedAt <= cutoff))
    cursor = page.nextCursor ?? undefined
    pages += 1
    if (pages > 100) throw new Error('Canonical exposure scan exceeded 100 pages')
  } while (cursor)
  return { items, pages, digest: sha256(canonical(items.map(item => ({ id: item.id,
    logicalMessageKey: item.logicalMessageKey, rawVersionId: item.rawVersionId,
    payloadSha256: item.observation.correlation.payloadSha256 ?? null })))) }
}

const explicitKey = (observation: ExposureObservation): string | null => {
  const correlation = observation.correlation
  if (typeof correlation.codexThreadId === 'string' && typeof correlation.codexTurnId === 'string') {
    return `codex-turn:${correlation.codexThreadId}:${correlation.codexTurnId}`
  }
  if (typeof correlation.runId === 'string') return `openclaw-run:${correlation.runId}`
  return null
}

const choose = (items: CanonicalItem[]) => {
  const groups = new Map<string, Group>()
  for (const item of items) {
    const key = explicitKey(item.observation)
    if (!key) continue
    const group: Group = groups.get(key) ?? { users: new Map<string, CanonicalItem>(), agents: [] }
    if (item.observation.direction === 'user_to_model' && item.logicalMessageKey) group.users.set(item.logicalMessageKey, item)
    if (item.observation.direction === 'model_to_user') group.agents.push(item)
    groups.set(key, group)
  }
  return [...groups.entries()].flatMap(([exchangeId, group]) => {
    if (group.users.size !== 1) return []
    const current = [...group.users.values()][0]!
    const responses = group.agents.filter(item => item.observation.hook === 'cli.codex.assistant_final_answer'
      || (exchangeId.startsWith('openclaw-run:') && item.observation.stage === 'delivered'))
      .sort((a, b) => a.observation.observedAt.localeCompare(b.observation.observedAt) || a.id.localeCompare(b.id))
    const response = responses.at(-1)
    if (!response || omitted(current) || omitted(response)) return []
    return [{ exchangeId, current, response }]
  }).sort((a, b) => a.current.observation.observedAt.localeCompare(b.current.observation.observedAt)
    || a.exchangeId.localeCompare(b.exchangeId))
}

const exactRefetch = async (service: LearningExposureService, item: CanonicalItem) => {
  if (!item.logicalMessageKey) throw new Error('Selected item lacks logicalMessageKey')
  const page = await service.query({ limit: 100, logicalMessageKey: item.logicalMessageKey, includeUnknown: false })
  const found = page.items.find(candidate => candidate.id === item.id)
  if (!found || found.rawVersionId !== item.rawVersionId || text(found) !== text(item)) {
    throw new Error(`Canonical exact-key refetch changed selected item ${item.id}`)
  }
  return found
}

const main = async () => {
  const options = parse()
  const cutoff = new Date().toISOString()
  const handle = openLearnerDatabase({ readOnly: true })
  const db = handle.kysely
  try {
    const service = new LearningExposureService(db)
    const first = await scan(service, cutoff)
    const second = await scan(service, cutoff)
    if (first.digest !== second.digest) throw new Error('Canonical live pages changed across the bounded double scan')
    const eligible = choose(second.items)
    if (eligible.length < options.pairCount) {
      throw new Error(`Only ${eligible.length} exact final/delivered pairs with complete bounded text exist; requested ${options.pairCount}`)
    }
    const selected = eligible.slice(-options.pairCount)
    const cases = []
    for (const [ordinal, pair] of selected.entries()) {
      const correlation = pair.current.observation.correlation
      const unique = typeof correlation.codexThreadId === 'string' && typeof correlation.codexTurnId === 'string'
        ? await service.explicitUserIdentityIsUnique({ codexThreadId: correlation.codexThreadId,
          codexTurnId: correlation.codexTurnId })
        : typeof correlation.runId === 'string'
          ? await service.explicitUserIdentityIsUnique({ runId: correlation.runId }) : false
      if (!unique) throw new Error(`Selected exchange lost storewide explicit identity uniqueness: ${pair.exchangeId}`)
      const [current, response] = await Promise.all([
        exactRefetch(service, pair.current), exactRefetch(service, pair.response),
      ])
      const currentText = text(current); const responseText = text(response)
      cases.push({
        caseId: sha256(`${pair.exchangeId}\0${current.id}\0${response.id}`).slice(0, 32), ordinal,
        exchangeId: pair.exchangeId,
        current: { id: current.id, logicalMessageKey: current.logicalMessageKey, rawVersionId: current.rawVersionId,
          observedAt: current.observation.observedAt, text: currentText, textSha256: sha256(currentText), media: current.media },
        response: { id: response.id, logicalMessageKey: response.logicalMessageKey, rawVersionId: response.rawVersionId,
          observedAt: response.observation.observedAt, hook: response.observation.hook,
          text: responseText, textSha256: sha256(responseText), media: response.media },
      })
    }
    const membership = cases.map(({ caseId, exchangeId, current, response }) => ({ caseId, exchangeId,
      current: { id: current.id, logicalMessageKey: current.logicalMessageKey, rawVersionId: current.rawVersionId,
        observedAt: current.observedAt, textSha256: current.textSha256 },
      response: { id: response.id, logicalMessageKey: response.logicalMessageKey, rawVersionId: response.rawVersionId,
        observedAt: response.observedAt, textSha256: response.textSha256, hook: response.hook } }))
    const manifest = { schemaVersion: 1, label: options.label, cutoff, pairCount: cases.length,
      messageCount: cases.length * 2, membershipDigest: sha256(canonical(membership)), cases,
      sourceCompleteness: { consumer: 'LearningExposureService.query', includeUnknown: false,
        pagesPerScan: second.pages, materializedMessageCount: second.items.length,
        doubleScanDigest: second.digest, stableDoubleScan: true, transactionallyFrozen: false,
        exactLogicalKeyRefetch: true, storewideExplicitIdentityRecheck: true,
        eligibleStrictPairCount: eligible.length,
        parity: { state: 'pending', note: 'Parity is recorded separately and does not block indefinitely.' } },
      selection: { order: 'human observedAt ascending, exchangeId ascending; take latest N',
        linkage: 'storewide-unique explicit Codex thread+turn or OpenClaw run only',
        response: 'latest true Codex final answer or confirmed OpenClaw delivery', textOnlyModelInput: true,
        mediaReferencesPreservedButNotRead: cases.reduce((sum, item) => sum + item.current.media.length + item.response.media.length, 0) },
    }
    await mkdir(dirname(options.output), { recursive: true, mode: 0o700 })
    await writeFile(options.output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await chmod(options.output, 0o600)
    console.log(JSON.stringify({ output: options.output, pairCount: cases.length, messageCount: cases.length * 2,
      membershipDigest: manifest.membershipDigest, cutoff, eligibleStrictPairCount: eligible.length,
      sourceCompleteness: manifest.sourceCompleteness, mediaReferences: manifest.selection.mediaReferencesPreservedButNotRead }))
  } finally { await handle.close() }
}

await main()

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { COMPUTER_SCIENCE } from './computer-science-seed.js'
import { FROZEN_COMPUTER_SCIENCE_V1 } from './computer-science-2026-09-04.snapshot.js'
import { LearningGraphSchema } from './learning-seed.js'
import { CLASSIFIER_V6_CATALOG, CLASSIFIER_V6_CATALOG_HASH } from '../../lib/learning/learning-classifier-v6.js'

const graph = COMPUTER_SCIENCE
const byId = new Map(graph.concepts.map((concept) => [concept.id, concept]))
const byModule = new Map(graph.curriculum.modules.map((module) => [module.id, module]))

function assertDag(ids: Iterable<string>, dependencies: Map<string, string[]>): void {
  const active = new Set<string>()
  const completed = new Set<string>()
  const visit = (id: string): void => {
    assert.ok(!active.has(id), `Prerequisite cycle through ${id}`)
    if (completed.has(id)) return
    active.add(id)
    for (const dependency of dependencies.get(id) ?? []) visit(dependency)
    active.delete(id)
    completed.add(id)
  }
  for (const id of ids) visit(id)
}

test('curriculum preserves all original 470 definitions and the immutable V6 catalog', () => {
  const original = graph.concepts.filter((concept) => concept.provenance.version === 'cs-2026-09-04.1')
  assert.equal(original.length, 470)
  assert.deepEqual(original, FROZEN_COMPUTER_SCIENCE_V1.concepts)
  assert.equal(FROZEN_COMPUTER_SCIENCE_V1.curriculum.modules.length, 94)
  assert.equal(createHash('sha256').update(JSON.stringify(FROZEN_COMPUTER_SCIENCE_V1)).digest('hex'), '30596e3d7ad7c26076cc375f72a0a64e86ce885292c059649228f4851796cf75')
  assert.equal(createHash('sha256').update(JSON.stringify(original)).digest('hex'), 'e250a8e641ef3f9a63eee74a65fe7095650a6ffafde75ff849b909e50bd7ad90')
  assert.equal(createHash('sha256').update(original.map((concept) => concept.id).sort().join('\n')).digest('hex'), '5201672f16f840a47087400e0478fd6e223b633da77271ed60bc4f61b5291295')
  assert.equal(CLASSIFIER_V6_CATALOG.length, 470)
  assert.equal(CLASSIFIER_V6_CATALOG_HASH, 'c5d2c547930f2e9ae5f5bd24c88843397ecbd58ea477a6be6ad4a92012c61611')
  assert.deepEqual(CLASSIFIER_V6_CATALOG.map(({ id, title }) => ({ id, title })), original.map(({ id, title }) => ({ id, title })))
})

test('every lesson, lane, concept membership, and prerequisite resolves in two acyclic graphs', () => {
  LearningGraphSchema.parse(graph)
  assert.equal(byId.size, graph.concepts.length)
  assert.equal(byModule.size, graph.curriculum.modules.length)
  const lanes = new Set(graph.curriculum.lanes.map((lane) => lane.id))
  assert.equal(lanes.size, graph.curriculum.lanes.length)
  assert.equal(new Set(graph.curriculum.modules.map((module) => module.step)).size, byModule.size)
  const members = new Set<string>()
  const moduleDependencies = new Map<string, string[]>()
  for (const module of graph.curriculum.modules) {
    assert.ok(lanes.has(module.laneId), module.id)
    assert.ok(module.conceptIds.length > 0, module.id)
    assert.equal(new Set(module.conceptIds).size, module.conceptIds.length, module.id)
    assert.equal(module.parentId, null, 'Display sequence must not become tree ownership')
    for (const id of module.conceptIds) {
      assert.ok(byId.has(id), `${module.id} refers to missing ${id}`)
      members.add(id)
    }
    for (const id of module.dependsOnModuleIds) {
      assert.ok(byModule.has(id), `${module.id} depends on missing ${id}`)
      assert.notEqual(id, module.id)
    }
    moduleDependencies.set(module.id, module.dependsOnModuleIds)
  }
  assert.deepEqual([...members].sort(), [...byId.keys()].sort(), 'Every concept must have at least one lesson')
  const conceptDependencies = new Map<string, string[]>()
  const edgeKeys = new Set<string>()
  for (const edge of graph.edges) {
    assert.ok(byId.has(edge.from) && byId.has(edge.to), `${edge.from} -> ${edge.to}`)
    assert.notEqual(edge.from, edge.to)
    const key = `${edge.from}:${edge.to}:${edge.kind}`
    assert.ok(!edgeKeys.has(key), key)
    edgeKeys.add(key)
    if (edge.kind === 'hard-prerequisite') conceptDependencies.set(edge.to, [...(conceptDependencies.get(edge.to) ?? []), edge.from])
  }
  assertDag(byModule.keys(), moduleDependencies)
  assertDag(byId.keys(), conceptDependencies)
})

test('practical foundations have concrete lessons and useful prerequisite paths without order-derived theory gates', () => {
  const required = ['web-html--div-and-span', 'web-dom--dom-tree', 'web-box-model--margin', 'web-box-model--padding', 'web-box-model--box-sizing', 'web-layout-flow--normal-flow', 'web-flexbox--flex-container', 'web-grid--grid-container', 'react-components--component-props', 'react-state--react-state-snapshot', 'react-effects--stale-asynchronous-result', 'web-accessible-interaction--focus-management', 'practice-debugging--causal-boundary-trace', 'practice-testing--behavioral-assertion', 'api-http--fetch-response-handling', 'workflow-idempotency--uncertain-external-outcome', 'llm-agent-steering--evidence-based-correction']
  for (const id of required) {
    const concept = byId.get(id)
    assert.ok(concept, id)
    assert.ok(concept.summary.length > 45 && concept.example.length > 40, `${id} needs a definition and a concrete check`)
    assert.ok(graph.curriculum.modules.some((module) => module.conceptIds.includes(id)), id)
  }
  const hard = new Set(graph.edges.filter((edge) => edge.kind === 'hard-prerequisite').map(({ from, to }) => `${from}:${to}`))
  assert.ok(hard.has('web-box-model--css-box-model:web-box-model--padding'))
  assert.ok(hard.has('web-box-model--css-box-model:web-box-model--margin'))
  assert.ok(hard.has('react-state--react-state-snapshot:react-state--state-updater'))
  assert.ok(!hard.has('web-box-model--padding:web-box-model--margin'), 'Siblings are related, not automatically prerequisites')
  assert.ok(!hard.has('foundations-computation--input:foundations-computation--output'), 'Original five-item order must not become prerequisites')
  assert.deepEqual(byModule.get('web-html')?.dependsOnModuleIds, [])
  assert.deepEqual(byModule.get('api-url')?.dependsOnModuleIds, [])
  assert.ok(!byModule.get('foundations-models')?.dependsOnModuleIds.includes('foundations-information'))
  assert.ok(!byModule.get('ds-statistical-inference')?.dependsOnModuleIds.includes('math-inference'))
  assert.ok(new Set(graph.curriculum.modules.map((module) => module.conceptIds.length)).size > 1, 'Lesson size follows content, not a five-concept quota')
})

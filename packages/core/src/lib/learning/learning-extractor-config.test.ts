import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { assertSelectableCombination, resolveHonoredSelection, findCatalogEntry } from '@learner/llm/lib/llm/model-catalog.js'
import { ExtractorSelection } from '@learner/contract/learning/learning-admin.js'
import { DEFAULT_LEARNING_EXTRACTOR_CONFIG, saveLearningExtractorConfig } from './learning-extractor-config.js'

describe('Learning extractor live default', () => {
  test('uses Codex GPT-5.6 Luna at high, a probed combination, and resolves its effective slug', () => {
    assert.deepEqual(DEFAULT_LEARNING_EXTRACTOR_CONFIG, {
      backend: 'codex',
      model: 'gpt-5.6-luna',
      effort: 'high',
      updatedAt: null,
    })
    assert.doesNotThrow(() => assertSelectableCombination(
      DEFAULT_LEARNING_EXTRACTOR_CONFIG.backend,
      DEFAULT_LEARNING_EXTRACTOR_CONFIG.model,
      DEFAULT_LEARNING_EXTRACTOR_CONFIG.effort,
    ))
    const entry = findCatalogEntry('codex', 'gpt-5.6-luna')
    assert.ok(entry)
    assert.deepEqual(resolveHonoredSelection(entry, 'high'), { model: 'gpt-5.6-luna', effort: 'high' })
  })
})

describe('Learning extractor backends', () => {
  test('AGY is refused by the wire contract and by the save itself, before anything is written', async () => {
    assert.equal(ExtractorSelection.safeParse({ backend: 'agy', model: 'gemini-3.7-flash', effort: 'high' }).success, false)
    assert.equal(ExtractorSelection.safeParse({ backend: 'codex', model: 'gpt-5.6-luna', effort: 'high' }).success, true)
    // A selectable AGY combination still fails: the backend rule runs first, so no query is issued.
    await assert.rejects(
      saveLearningExtractorConfig({ backend: 'agy' as 'codex', model: 'gemini-3.7-flash', effort: 'high' }, 'test'),
      /cannot run on agy/,
    )
  })
})

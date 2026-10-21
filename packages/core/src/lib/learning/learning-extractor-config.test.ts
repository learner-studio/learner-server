import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { assertSelectableCombination, resolveHonoredSelection, findCatalogEntry } from '@learner/llm/lib/llm/model-catalog.js'
import { DEFAULT_LEARNING_EXTRACTOR_CONFIG } from './learning-extractor-config.js'

describe('Learning extractor live default', () => {
  test('uses the selectable AGY Gemini 3.7 Flash High family and resolves its effective slug', () => {
    assert.deepEqual(DEFAULT_LEARNING_EXTRACTOR_CONFIG, {
      backend: 'agy',
      model: 'gemini-3.7-flash',
      effort: 'high',
      updatedAt: null,
    })
    assert.doesNotThrow(() => assertSelectableCombination(
      DEFAULT_LEARNING_EXTRACTOR_CONFIG.backend,
      DEFAULT_LEARNING_EXTRACTOR_CONFIG.model,
      DEFAULT_LEARNING_EXTRACTOR_CONFIG.effort,
    ))
    const entry = findCatalogEntry('agy', 'gemini-3.7-flash')
    assert.ok(entry)
    assert.deepEqual(resolveHonoredSelection(entry, 'high'), {
      model: 'gemini-3.7-flash-high',
      effort: 'high',
    })
  })
})

import { expect, test } from 'bun:test'
import { createLLMTraceId } from './llm-service.js'

test('an LLM trace id keeps the whole run id of its label, so the log line joins to the run', () => {
  const runId = '0f8fad5b-d9cb-469f-a165-70867728950e'
  expect(createLLMTraceId(`Learning concept assessment ${runId}`)).toStartWith(`learning-concept-assessment-${runId}-`)
})

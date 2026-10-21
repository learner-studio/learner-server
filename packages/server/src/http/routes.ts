/**
 * REST routes carried over unchanged from the previous host's route table
 * (paths, methods and auth). Data is the merge of query, JSON body and path
 * params, as before. Every other function is reached through POST /rpc/:name.
 */
export interface Route { method: 'get' | 'post' | 'put' | 'delete'; path: string; func: string; auth?: false; requireApiKey?: true }

export const ROUTES: readonly Route[] = [
  { method: 'get', path: '/api/learning/graph', func: 'getLearningGraph' },
  { method: 'get', path: '/api/learning/extractor-config', func: 'getLearningExtractorConfig' },
  { method: 'put', path: '/api/learning/extractor-config', func: 'saveLearningExtractorConfigFunction' },
  { method: 'get', path: '/api/learning/extraction-benchmarks', func: 'getLearningExtractionBenchmarks' },
  { method: 'get', path: '/api/learning/extraction-corpus', func: 'getLearningExtractionCorpus' },
  { method: 'get', path: '/api/learning/extractions', func: 'getLearningExtractions' },
  { method: 'post', path: '/api/learning/extraction-benchmarks', func: 'startLearningExtractionBenchmark' },
  { method: 'get', path: '/api/learning/conversation-history', func: 'getConversationHistory' },
  // Provider lifecycle hooks are unauthenticated by design (local-MVP gated in the function).
  { method: 'post', path: '/api/learning/hooks/:provider', func: 'receiveLearningHook', auth: false },
  { method: 'post', path: '/api/learning/turn-context', func: 'getLearningTurnContext' },
  { method: 'post', path: '/api/learning/episode-analysis', func: 'startLearningEpisodeAnalysis' },
  { method: 'get', path: '/api/learning/outcome-steering', func: 'getOutcomeSteeringEvaluations' },
  { method: 'get', path: '/api/learning/playground/fixtures', func: 'getLearningPlaygroundFixtures' },
  { method: 'post', path: '/api/learning/playground/turns', func: 'startLearningPlaygroundTurn' },
  { method: 'get', path: '/api/learning/playground/turns/:runId', func: 'getLearningPlaygroundTurn' },
  { method: 'post', path: '/api/internal/hindsight/v1/chat/completions', func: 'hindsightAgyOpenAIChat', requireApiKey: true },
]

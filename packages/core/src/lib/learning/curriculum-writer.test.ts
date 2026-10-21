import { describe, expect, test } from 'bun:test'
import {
  alignProposalTopics, normalizeTopic,
  proposalGroundingProblems, conceptGroundingProblems, conceptEdgeGroundingProblems, dependencyGroundingProblems,
  outlineGroundingProblems,
  buildCurriculumRows, validateCurriculumWrite, type CurriculumWriteRequest } from './curriculum-writer.js'
import type { CurriculumGraphProposal, CurriculumOutline, CurriculumSourceRef } from './curriculum-generation-types.js'

const source: CurriculumSourceRef = {
  sourceId: '6-006', provider: 'mit-ocw', title: 'Introduction to Algorithms',
  url: 'https://ocw.mit.edu/courses/6-006/', licence: 'CC BY-NC-SA 4.0',
  attribution: 'MIT OpenCourseWare', retrievedAt: '2026-09-09T12:00:00.000Z', contentChars: 40_000,
}

/** A four-module course, the smallest a 'course' is allowed to be. */
const outline = (overrides: Partial<CurriculumOutline> = {}): CurriculumOutline => ({
  title: 'Algorithms', description: 'A first course in algorithms.',
  domain: 'algorithms', scale: 'course',
  lanes: [
    { id: 'foundations', title: 'Foundations', summary: 'Groundwork.' },
    { id: 'structures', title: 'Structures', summary: 'Data structures.' },
  ],
  modules: [
    { id: 'm0', laneId: 'foundations', title: 'Asymptotics', summary: 'Growth rates.', topics: ['big-o', 'recurrences'], sourceIds: ['6-006'] },
    { id: 'm1', laneId: 'foundations', title: 'Sorting', summary: 'Comparison sorts.', topics: ['merge sort'], sourceIds: ['6-006'] },
    { id: 'm2', laneId: 'structures', title: 'Hashing', summary: 'Hash tables.', topics: ['hash table'], sourceIds: [] },
    { id: 'm3', laneId: 'structures', title: 'Trees', summary: 'Balanced trees.', topics: ['avl tree'], sourceIds: [] },
  ],
  // The outline carries the spine since 2026-09-11; the proposal echoes it.
  moduleDependencies: [
    { moduleId: 'm1', dependsOnModuleId: 'm0', confidence: 0.9, rationale: 'Sorting needs growth rates.' },
    { moduleId: 'm2', dependsOnModuleId: 'm0', confidence: 0.7, rationale: 'Hashing needs growth rates.' },
    { moduleId: 'm3', dependsOnModuleId: 'm1', confidence: 0.6, rationale: 'Trees follow sorting.' },
  ],
  ...overrides,
})

const detail = (moduleId: string, topic: string, name: string) => ({
  moduleId, topic, name, summary: 's', explanation: 'e', example: 'x', capability: 'explain' as const,
})

const proposal = (overrides: Partial<CurriculumGraphProposal> = {}): CurriculumGraphProposal => ({
  moduleDependencies: [
    { moduleId: 'm1', dependsOnModuleId: 'm0', confidence: 0.9, rationale: 'Sorting needs growth rates.' },
    { moduleId: 'm2', dependsOnModuleId: 'm0', confidence: 0.7, rationale: 'Hashing needs growth rates.' },
    { moduleId: 'm3', dependsOnModuleId: 'm1', confidence: 0.6, rationale: 'Trees follow sorting.' },
  ],
  // Two concepts per approved topic: the floor the grounding check enforces,
  // and the shape the whole 2026-09-10 change exists to produce. A fixture with
  // one concept per topic would be the OLD contract and would now be refused.
  concepts: [
    detail('m0', 'big-o', 'Asymptotic growth'),
    detail('m0', 'big-o', 'Upper bound'),
    detail('m0', 'recurrences', 'Recurrence relation'),
    detail('m0', 'recurrences', 'Master theorem'),
    detail('m1', 'merge sort', 'Divide and conquer'),
    detail('m1', 'merge sort', 'Stable sort'),
    detail('m2', 'hash table', 'Hash function'),
    detail('m2', 'hash table', 'Collision resolution'),
    detail('m3', 'avl tree', 'Tree rotation'),
    detail('m3', 'avl tree', 'Balance factor'),
  ],
  conceptEdges: [{ fromConcept: 'Asymptotic growth', toConcept: 'Divide and conquer', kind: 'hard-prerequisite', confidence: 0.8 }],
  ...overrides,
})

const request = (over: Partial<CurriculumWriteRequest> = {}): CurriculumWriteRequest => ({
  curriculumId: 'gen-algorithms', ownerUserId: 'owner-1',
  outline: outline(), proposal: proposal(), sources: [source], ...over,
})

describe('validateCurriculumWrite refuses a proposal that cannot be drawn', () => {
  test('a well-formed proposal has nothing to report', () => {
    expect(validateCurriculumWrite(request())).toEqual([])
  })

  test('a prerequisite circle is refused, naming the modules in it', () => {
    // The tree assigns each module a row from its prerequisite depth, so a
    // cycle has no terminating depth and cannot be laid out at all.
    const problems = validateCurriculumWrite(request({
      proposal: proposal({ moduleDependencies: [
        { moduleId: 'm0', dependsOnModuleId: 'm1', confidence: 0.9, rationale: '' },
        { moduleId: 'm1', dependsOnModuleId: 'm0', confidence: 0.9, rationale: '' },
      ] }),
    }))
    expect(problems.some((problem) => problem.includes('circle'))).toBe(true)
    expect(problems.some((problem) => problem.includes('m0') && problem.includes('m1'))).toBe(true)
  })

  test('a prerequisite naming a module outside the outline is refused', () => {
    const problems = validateCurriculumWrite(request({
      proposal: proposal({ moduleDependencies: [
        { moduleId: 'm1', dependsOnModuleId: 'not-a-module', confidence: 0.9, rationale: '' },
      ] }),
    }))
    expect(problems.some((problem) => problem.includes('not-a-module'))).toBe(true)
  })

  test('a module in a lane the outline never declared is refused', () => {
    const broken = outline()
    const problems = validateCurriculumWrite(request({
      outline: { ...broken, modules: broken.modules.map((m) => m.id === 'm2' ? { ...m, laneId: 'ghost-lane' } : m) },
    }))
    expect(problems.some((problem) => problem.includes('ghost-lane'))).toBe(true)
  })

  test('a topic approved but never written is reported, because the learner would silently get less', () => {
    // This is the failure a learner is least able to notice: they approved an
    // outline and would receive a smaller tree with no explanation.
    const problems = validateCurriculumWrite(request({
      proposal: proposal({ concepts: proposal().concepts.filter((c) => c.topic !== 'recurrences') }),
    }))
    expect(problems.some((problem) => problem.includes('recurrences'))).toBe(true)
  })

  test('a concept invented for a topic nobody approved is refused', () => {
    const problems = validateCurriculumWrite(request({
      proposal: proposal({ concepts: [...proposal().concepts, detail('m0', 'quantum', 'Qubit')] }),
    }))
    expect(problems.some((problem) => problem.includes('quantum'))).toBe(true)
  })

  test('a course outside its size limits is refused', () => {
    const small = outline()
    const problems = validateCurriculumWrite(request({
      outline: { ...small, modules: small.modules.slice(0, 2) },
      proposal: proposal({ moduleDependencies: [], concepts: proposal().concepts.filter((c) => ['m0', 'm1'].includes(c.moduleId)) }),
    }))
    expect(problems.some((problem) => problem.includes('between 4 and 20 modules'))).toBe(true)
  })

  test('every problem is reported, not only the first', () => {
    // A run that fails is shown to the person who asked for the curriculum,
    // and one problem at a time makes fixing it a guessing game.
    const problems = validateCurriculumWrite(request({
      proposal: proposal({ moduleDependencies: [
        { moduleId: 'ghost-a', dependsOnModuleId: 'm0', confidence: 0.9, rationale: '' },
        { moduleId: 'm1', dependsOnModuleId: 'ghost-b', confidence: 0.9, rationale: '' },
      ] }),
    }))
    expect(problems.length).toBeGreaterThanOrEqual(2)
  })
})

describe('edges the writer refuses are counted, not swallowed', () => {
  // Every one of these is a legitimate refusal. What was wrong was that all
  // three were the same silent `continue`, so the only evidence a curriculum
  // held fewer links than the model proposed was a subtraction nobody did.
  const edge = (fromConcept: string, toConcept: string, kind: 'hard-prerequisite' | 'related' = 'hard-prerequisite') =>
    ({ fromConcept, toConcept, kind, confidence: 0.8 })

  test('an edge naming a concept that exists in two modules is dropped as ambiguous', () => {
    // 'Upper bound' written into m1 as well means the name no longer picks out
    // one concept, and guessing which one the model meant would invent a link.
    const rows = buildCurriculumRows(request({
      proposal: proposal({
        concepts: [...proposal().concepts, detail('m1', 'merge sort', 'Upper bound')],
        conceptEdges: [edge('Upper bound', 'Divide and conquer')],
      }),
    }))
    expect(rows.conceptEdges).toHaveLength(0)
    expect(rows.conceptEdgeDrops.ambiguousEndpoint).toBe(1)
  })

  test('an endpoint naming no concept at all is counted the same way', () => {
    const rows = buildCurriculumRows(request({
      proposal: proposal({ conceptEdges: [edge('Asymptotic growth', 'Quantum entanglement')] }),
    }))
    expect(rows.conceptEdges).toHaveLength(0)
    expect(rows.conceptEdgeDrops.ambiguousEndpoint).toBe(1)
  })

  test('the same pair proposed twice is drawn once and the repeat is counted', () => {
    const rows = buildCurriculumRows(request({
      proposal: proposal({ conceptEdges: [
        edge('Asymptotic growth', 'Divide and conquer'),
        edge('Asymptotic growth', 'Divide and conquer'),
      ] }),
    }))
    expect(rows.conceptEdges).toHaveLength(1)
    expect(rows.conceptEdgeDrops.duplicate).toBe(1)
  })

  test('one pair gets one link even when two calls disagree about the kind', () => {
    // The lane pass and the whole-graph edge pass can both reach the same pair.
    // Two labels for one relationship is a disagreement, not two relationships,
    // and the first writer wins rather than the graph gaining a parallel edge.
    const rows = buildCurriculumRows(request({
      proposal: proposal({ conceptEdges: [
        edge('Asymptotic growth', 'Divide and conquer', 'hard-prerequisite'),
        edge('Asymptotic growth', 'Divide and conquer', 'related'),
      ] }),
    }))
    expect(rows.conceptEdges).toHaveLength(1)
    expect(rows.conceptEdges[0]?.kind).toBe('hard-prerequisite')
    expect(rows.conceptEdgeDrops.duplicate).toBe(1)
  })

  test('a clean proposal drops nothing, so a non-zero count always means something happened', () => {
    const rows = buildCurriculumRows(request())
    expect(rows.conceptEdges).toHaveLength(1)
    expect(rows.conceptEdgeDrops).toEqual({ ambiguousEndpoint: 0, selfAfterResolution: 0, duplicate: 0 })
  })
})

describe('buildCurriculumRows produces a curriculum that cannot collide with another', () => {
  test('concept ids are namespaced by curriculum and module', () => {
    // Two generated curricula share the learning_concepts table, so an id
    // derived from the topic alone would let one overwrite the other's
    // definitions.
    const rows = buildCurriculumRows(request())
    expect(rows.concepts.every((concept) => concept.id.startsWith('gen-algorithms.'))).toBe(true)
    expect(rows.concepts.map((c) => c.id)).toContain('gen-algorithms.m0--asymptotic-growth')
    expect(new Set(rows.concepts.map((c) => c.id)).size).toBe(rows.concepts.length)
  })

  test('generated rows are marked generated, so a seed re-sync cannot sweep them', () => {
    // syncSeeds deletes orphaned concepts WHERE source_kind = 'seed'. A
    // generated concept written as a seed could be deleted by an unrelated
    // re-seed of the shipped library.
    const rows = buildCurriculumRows(request())
    expect(rows.curriculum.sourceKind).toBe('generated')
    expect(rows.concepts.every((concept) => concept.sourceKind === 'generated')).toBe(true)
  })

  test('a generated curriculum is written as a draft owned by the learner who asked', () => {
    const rows = buildCurriculumRows(request())
    expect(rows.curriculum.status).toBe('draft')
    expect(rows.curriculum.ownerUserId).toBe('owner-1')
  })

  test('provenance distinguishes a transcribed module from an invented one', () => {
    // This is the distinction the whole comparison against the seed rests on.
    const rows = buildCurriculumRows(request())
    const grounded = rows.modules.find((module) => module.id === 'm0')
    const invented = rows.modules.find((module) => module.id === 'm2')
    expect(grounded!.provenance.kind).toBe('external-material')
    expect(grounded!.provenance.source).toBe('mit-ocw:6-006')
    expect(invented!.provenance.kind).toBe('model-generated')
  })

  test('every proposed concept is written, not one per approved topic', () => {
    // THE regression this file exists to pin. The loop used to walk
    // `module.topics` and write exactly one row each, so a lane that proposed
    // thirty concepts had twenty-four of them dropped without a word — which is
    // why every generated curriculum measured 1.4-1.8 concepts per module
    // against the seed's 4.99. Ten concepts in, ten rows out.
    const rows = buildCurriculumRows(request())
    expect(rows.concepts.length).toBe(10)
    expect(rows.memberships.length).toBe(10)
    expect(rows.memberships.every((m) => m.curriculumId === 'gen-algorithms')).toBe(true)
    // The concept TITLE is the concept's own name, never the lesson's line.
    expect(rows.concepts.map((c) => c.title)).toContain('Asymptotic growth')
    expect(rows.concepts.map((c) => c.title)).not.toContain('big-o')
  })

  test('a module\'s memberships are numbered from one, across all its topics', () => {
    // Position orders the module's concepts for the learner, so it counts
    // concepts and not topics — two topics of two concepts is 1..4, not 1,1,2,2.
    const rows = buildCurriculumRows(request())
    const m0 = rows.memberships.filter((m) => m.moduleId === 'm0').map((m) => m.position)
    expect(m0).toEqual([1, 2, 3, 4])
  })

  test('a prerequisite proposed twice is written once, keeping the stronger claim', () => {
    const rows = buildCurriculumRows(request({
      proposal: proposal({ moduleDependencies: [
        { moduleId: 'm1', dependsOnModuleId: 'm0', confidence: 0.4, rationale: 'weak' },
        { moduleId: 'm1', dependsOnModuleId: 'm0', confidence: 0.95, rationale: 'strong' },
      ] }),
    }))
    expect(rows.moduleDependencies.length).toBe(1)
    expect(rows.moduleDependencies[0]!.confidence).toBe(0.95)
    expect(rows.moduleDependencies[0]!.rationale).toBe('strong')
  })

  test('a module made its own prerequisite is dropped rather than written', () => {
    const rows = buildCurriculumRows(request({
      proposal: proposal({ moduleDependencies: [{ moduleId: 'm1', dependsOnModuleId: 'm1', confidence: 0.9, rationale: '' }] }),
    }))
    expect(rows.moduleDependencies).toEqual([])
  })

  test('a concept edge is kept only when both of its names resolve to one concept', () => {
    // Edges are proposed between concept NAMES, which grounding makes unique
    // within a module but not across the curriculum. An ambiguous endpoint is
    // dropped rather than guessed, because guessing wires a learner's tree to
    // the wrong node.
    const rows = buildCurriculumRows(request({
      proposal: proposal({
        concepts: [
          ...proposal().concepts,
          // 'Master theorem' now exists in m2 as well as m0.
          detail('m2', 'hash table', 'Master theorem'),
        ],
        conceptEdges: [
          { fromConcept: 'Master theorem', toConcept: 'Stable sort', kind: 'hard-prerequisite', confidence: 0.8 },
          { fromConcept: 'Recurrence relation', toConcept: 'Balance factor', kind: 'related', confidence: 0.5 },
        ],
      }),
    }))
    expect(rows.conceptEdges.length).toBe(1)
    expect(rows.conceptEdges[0]!.toConceptId).toBe('gen-algorithms.m3--balance-factor')
  })

  test('lanes get distinct colours and an order, because both columns are NOT NULL', () => {
    const rows = buildCurriculumRows(request())
    expect(rows.lanes.map((lane) => lane.laneOrder)).toEqual([1, 2])
    expect(new Set(rows.lanes.map((lane) => lane.color)).size).toBe(2)
  })

  test('concepts are positioned on the seed\'s grid rather than piled at the origin', () => {
    const rows = buildCurriculumRows(request())
    const first = rows.concepts.find((concept) => concept.id === 'gen-algorithms.m0--asymptotic-growth')
    expect(first!.x).toBe(120)
    expect(first!.y).toBe(90)
    expect(new Set(rows.concepts.map((c) => `${c.x},${c.y}`)).size).toBe(rows.concepts.length)
  })
})

describe('a proposal must be about the outline it was asked for', () => {
  const outline = {
    modules: [
      { id: 'm0', title: 'First', topics: ['t'] },
      { id: 'm1', title: 'Second', topics: ['t'] },
    ],
  } as Parameters<typeof proposalGroundingProblems>[0]
  /** The floor: two concepts for the module's one topic. */
  const covered = (moduleId: string) => [
    detail(moduleId, 't', `${moduleId} alpha`),
    detail(moduleId, 't', `${moduleId} beta`),
  ]

  test('the model\'s own schema skeleton is refused, naming what is wrong', () => {
    // Measured 2026-09-09: a 54-module outline came back as one dependency and
    // one concept with every id the literal "string". That reply is VALID
    // against the JSON Schema, so it parsed and the retry never fired; the
    // failure surfaced two steps later as writer complaints about a module
    // called "string".
    const problems = proposalGroundingProblems(outline, {
      moduleDependencies: [{ moduleId: 'string', dependsOnModuleId: 'string', confidence: 0, rationale: 'string' }],
      concepts: covered('string'),
      conceptEdges: [],
    })
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.join(' ')).toContain('not in the outline')
  })

  test('a well-formed proposal has no problems', () => {
    expect(proposalGroundingProblems(outline, {
      moduleDependencies: [{ moduleId: 'm1', dependsOnModuleId: 'm0', confidence: 0.9, rationale: 'r' }],
      concepts: [...covered('m0'), ...covered('m1')],
      conceptEdges: [],
    })).toEqual([])
  })

  test('a topic given only ONE concept is refused, because that is the old skill-tree shape', () => {
    // The floor is what stops the fix regressing quietly. One concept per topic
    // parses, grounds against the approved list, and writes — it is simply the
    // graph we already had. Refusing it here puts the complaint inside the
    // retry loop, where the model can still be asked for the rest.
    const problems = proposalGroundingProblems(outline, {
      moduleDependencies: [],
      concepts: [detail('m0', 't', 'Alpha'), ...covered('m1')],
      conceptEdges: [],
    })
    expect(problems.join(' ')).toContain('"t" has 1')
    expect(problems.join(' ')).toContain('at least 2')
  })

  test('a module given no concepts at all is refused', () => {
    const problems = proposalGroundingProblems(outline, {
      moduleDependencies: [], concepts: covered('m0'), conceptEdges: [],
    })
    expect(problems.join(' ')).toContain('"m1"')
  })

  test('the messages name the ids, because they are what the retry shows the model', () => {
    const problems = proposalGroundingProblems(outline, {
      moduleDependencies: [{ moduleId: 'm0', dependsOnModuleId: 'm9', confidence: 0.5, rationale: 'r' }],
      concepts: [...covered('m0'), ...covered('m1')],
      conceptEdges: [],
    })
    expect(problems[0]).toContain('m0 -> m9')
  })
})

describe('the concepts written are the IDEAS INSIDE the topics the learner approved', () => {
  const topical = {
    modules: [{ id: 'net-l13', title: 'Quality of Service', topics: ['QoS-I: Why QoS', 'Basic Models and Architecture'] }],
  } as Parameters<typeof proposalGroundingProblems>[0]
  const pair = (topic: string, a: string, b: string) => [detail('net-l13', topic, a), detail('net-l13', topic, b)]
  const complete = [
    ...pair('QoS-I: Why QoS', 'Traffic class', 'Service guarantee'),
    ...pair('Basic Models and Architecture', 'IntServ', 'DiffServ'),
  ]

  test('a module title written as a topic is refused, inside the retry loop', () => {
    // The exact failure of run 9b005d78: the model answered concepts whose
    // topic was the module's own TITLE, both approved topics went unwritten,
    // and the writer refused the finished proposal two steps later. The
    // complaint has to be raised here or the model is never asked to fix it.
    const problems = proposalGroundingProblems(topical, {
      moduleDependencies: [],
      concepts: pair('QoS-I: Why QoS; Basic Models and Architecture', 'Traffic class', 'Service guarantee'),
      conceptEdges: [],
    })
    expect(problems.join(' ')).toContain('QoS-I: Why QoS; Basic Models and Architecture')
    expect(problems.join(' ')).toContain('never approved')
    expect(problems.join(' ')).toContain('"QoS-I: Why QoS" has 0')
  })

  test('a dropped topic is named even when nothing was invented', () => {
    const problems = proposalGroundingProblems(topical, {
      moduleDependencies: [], concepts: pair('QoS-I: Why QoS', 'Traffic class', 'Service guarantee'), conceptEdges: [],
    })
    expect(problems.join(' ')).toContain('"Basic Models and Architecture" has 0')
  })

  test('a concept NAMED after its own lesson is refused — that is the skill tree twice', () => {
    // The user-visible symptom that started this: a "concept network" whose
    // node labels were the course and session headings. It grounds perfectly
    // against the approved list, so nothing but this rule catches it.
    const problems = proposalGroundingProblems(topical, {
      moduleDependencies: [],
      concepts: [
        ...pair('QoS-I: Why QoS', 'QoS-I: Why QoS', 'Service guarantee'),
        ...pair('Basic Models and Architecture', 'IntServ', 'DiffServ'),
      ],
      conceptEdges: [],
    })
    expect(problems.join(' ')).toContain('restate the lesson or the module')
  })

  test('a concept named after its MODULE is refused for the same reason', () => {
    const problems = proposalGroundingProblems(topical, {
      moduleDependencies: [],
      concepts: [
        ...pair('QoS-I: Why QoS', 'Quality of Service', 'Service guarantee'),
        ...pair('Basic Models and Architecture', 'IntServ', 'DiffServ'),
      ],
      conceptEdges: [],
    })
    expect(problems.join(' ')).toContain('restate the lesson or the module')
  })

  test('one name used twice in a module is refused, because the second row would vanish', () => {
    // Two concepts with the same name collapse to one id at write time. Without
    // this rule the reply passes, the row count silently drops, and the topic
    // that "had two concepts" ends up with one.
    const problems = proposalGroundingProblems(topical, {
      moduleDependencies: [],
      concepts: [
        ...pair('QoS-I: Why QoS', 'Traffic class', 'Service guarantee'),
        ...pair('Basic Models and Architecture', 'Traffic class', 'DiffServ'),
      ],
      conceptEdges: [],
    })
    expect(problems.join(' ')).toContain('used twice')
  })

  test('several distinct concepts per approved topic has no problems', () => {
    expect(proposalGroundingProblems(topical, {
      moduleDependencies: [], concepts: complete, conceptEdges: [],
    })).toEqual([])
  })

  test('the complaint stops at five modules so the instruction is still readable', () => {
    const many = {
      modules: Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, title: `Module ${i}`, topics: ['t'] })),
    } as Parameters<typeof proposalGroundingProblems>[0]
    const problems = proposalGroundingProblems(many, {
      moduleDependencies: [],
      concepts: Array.from({ length: 9 }, (_, i) => detail(`m${i}`, 'wrong', `name ${i}`)),
      conceptEdges: [],
    })
    expect(problems.filter((p) => p.startsWith('Module "')).length).toBe(5)
    expect(problems.join(' ')).toContain('4 further module(s) have the same problem')
  })
})

describe('a topic spelled differently is the same topic', () => {
  const topical = {
    modules: [{ id: 'm0', title: 'Asymptotics', topics: ['Big-O notation', 'Master theorem'] }],
  } as Parameters<typeof proposalGroundingProblems>[0]
  const pair = (topic: string, a: string, b: string) => [detail('m0', topic, a), detail('m0', topic, b)]

  test('an en dash, a capital and doubled spaces all normalize away', () => {
    expect(normalizeTopic('Big\u2013O  notation.')).toBe(normalizeTopic('Big-O notation'))
  })

  test('a differing WORD is still a different topic', () => {
    expect(normalizeTopic('Big-O notation')).not.toBe(normalizeTopic('Big-O analysis'))
  })

  test('a cosmetic near-miss is snapped to the approved spelling and then passes', () => {
    const aligned = alignProposalTopics(topical, {
      moduleDependencies: [],
      concepts: [
        ...pair('big\u2013o notation', 'Asymptotic growth', 'Upper bound'),
        ...pair('Master Theorem', 'Recurrence relation', 'Divide and conquer'),
      ],
      // The edge spells a concept name in a different case than the concept did.
      conceptEdges: [{ fromConcept: 'asymptotic  growth', toConcept: 'recurrence relation', kind: 'hard-prerequisite', confidence: 0.9 }],
    })
    expect(aligned.concepts.map((c) => c.topic))
      .toEqual(['Big-O notation', 'Big-O notation', 'Master theorem', 'Master theorem'])
    // Edges are snapped too, because an edge whose endpoint does not resolve
    // is dropped silently by the writer — a near-miss would cost a real edge.
    expect(aligned.conceptEdges[0]).toMatchObject({ fromConcept: 'Asymptotic growth', toConcept: 'Recurrence relation' })
    expect(proposalGroundingProblems(topical, aligned)).toEqual([])
  })

  test('an edge naming a concept this proposal never wrote is left alone', () => {
    // Cross-lane edges name a concept an EARLIER lane wrote, which is not in
    // this reply. Snapping must not invent a local match for it; the writer
    // resolves it against the whole curriculum, or drops it.
    const aligned = alignProposalTopics(topical, {
      moduleDependencies: [],
      concepts: pair('Big-O notation', 'Asymptotic growth', 'Upper bound'),
      conceptEdges: [{ fromConcept: 'Asymptotic growth', toConcept: 'TCP congestion window', kind: 'related', confidence: 0.4 }],
    })
    expect(aligned.conceptEdges[0]!.toConcept).toBe('TCP congestion window')
  })

  test('an invented topic is left alone, so the grounding check still catches it', () => {
    const aligned = alignProposalTopics(topical, {
      moduleDependencies: [],
      concepts: [
        ...pair('Amortized analysis', 'Potential function', 'Aggregate method'),
        ...pair('Master theorem', 'Recurrence relation', 'Divide and conquer'),
      ],
      conceptEdges: [],
    })
    expect(aligned.concepts[0]!.topic).toBe('Amortized analysis')
    expect(proposalGroundingProblems(topical, aligned).join(' ')).toContain('Amortized analysis')
  })
})

describe('a lane is judged on its own modules and not on the whole curriculum', () => {
  // The concepts of a curriculum are asked for ONE LANE AT A TIME, because
  // asking for all of them in a single call put run ee00295d over the CLI's
  // 394-second kill timer. That only works if the grounding check can be
  // scoped the same way: a checker that insisted on seeing every module would
  // reject every lane call for the modules it was deliberately not asked for.
  const foundations = [{ id: 'm0', title: 'Asymptotics', topics: ['Big-O'] }]
  const graphs = [{ id: 'm1', title: 'Traversal', topics: ['Breadth-first search'] }]
  const covered = (moduleId: string, topic: string) => [
    detail(moduleId, topic, `${moduleId} alpha`),
    detail(moduleId, topic, `${moduleId} beta`),
  ]

  test('a complete lane reply is accepted even though the other lane is missing', () => {
    expect(conceptGroundingProblems(foundations, covered('m0', 'Big-O'))).toEqual([])
  })

  test('a lane that writes into another lane is refused, because another call owns those', () => {
    const problems = conceptGroundingProblems(foundations, [
      ...covered('m0', 'Big-O'), ...covered('m1', 'Breadth-first search'),
    ])
    expect(problems.join(' ')).toContain('m1')
    expect(problems.join(' ')).toContain('not one of the modules you were asked to write')
  })

  test('a lane that skips one of its OWN topics is still refused', () => {
    const twoTopics = [{ id: 'm0', title: 'Asymptotics', topics: ['Big-O', 'Master theorem'] }]
    const problems = conceptGroundingProblems(twoTopics, covered('m0', 'Big-O'))
    expect(problems.join(' ')).toContain('Master theorem')
  })

  test('prerequisites are judged against every module, since they span the lanes', () => {
    const all = [...foundations, ...graphs]
    expect(dependencyGroundingProblems(all, [
      { moduleId: 'm1', dependsOnModuleId: 'm0', confidence: 0.8, rationale: 'r' },
    ])).toEqual([])
    expect(dependencyGroundingProblems(all, [
      { moduleId: 'm1', dependsOnModuleId: 'm9', confidence: 0.8, rationale: 'r' },
    ]).join(' ')).toContain('m1 -> m9')
  })

  test('the whole-outline check is exactly the two halves together', () => {
    const outline = { modules: [...foundations, ...graphs] } as Parameters<typeof proposalGroundingProblems>[0]
    const proposal = {
      moduleDependencies: [{ moduleId: 'm1', dependsOnModuleId: 'm9', confidence: 0.8, rationale: 'r' }],
      concepts: covered('m0', 'Big-O'),
      conceptEdges: [],
    }
    expect(proposalGroundingProblems(outline, proposal)).toEqual([
      ...dependencyGroundingProblems(outline.modules, proposal.moduleDependencies),
      ...conceptGroundingProblems(outline.modules, proposal.concepts),
    ])
  })
})

describe('the prerequisite spine is checked where the learner will approve it', () => {
  // Folding the spine into the outline moved it in FRONT of the approval gate,
  // and nothing regenerates it afterwards. A bad edge used to be re-rolled on
  // the next rebuild; now it is approved once and kept, so it has to be caught
  // in the outline call's own retry loop.
  const modules = [
    { id: 'm0', laneId: 'l0', topics: ['a'], title: 'M0' },
    { id: 'm1', laneId: 'l0', topics: ['b'], title: 'M1' },
    { id: 'm2', laneId: 'l0', topics: ['c'], title: 'M2' },
  ]
  const dep = (moduleId: string, dependsOnModuleId: string) =>
    ({ moduleId, dependsOnModuleId, confidence: 0.8, rationale: 'r' })

  test('a circle is refused and the loop is named', () => {
    // It does not crash anything: prerequisiteDepths carries a trail and
    // refuses to recurse. It silently gives one module in the loop an
    // arbitrary depth, drawing a tree that claims a module comes after itself.
    const problems = dependencyGroundingProblems(modules, [dep('m1', 'm0'), dep('m2', 'm1'), dep('m0', 'm2')])
    expect(problems.some((problem) => problem.includes('form a circle'))).toBe(true)
    expect(problems.some((problem) => problem.includes('m0'))).toBe(true)
  })

  test('a module that depends on itself is the same failure', () => {
    expect(dependencyGroundingProblems(modules, [dep('m0', 'm0')])
      .some((problem) => problem.includes('circle'))).toBe(true)
  })

  test('a diamond is NOT a circle, so a branching course still passes', () => {
    // Two modules both depending on m0, both feeding m2, revisits m0 twice on
    // different paths. A checker keyed on "seen before" rather than "seen on
    // THIS path" would call that a cycle and refuse a perfectly ordinary shape.
    expect(dependencyGroundingProblems(
      [...modules, { id: 'm3', laneId: 'l0', topics: ['d'], title: 'M3' }],
      [dep('m1', 'm0'), dep('m3', 'm0'), dep('m2', 'm1'), dep('m2', 'm3')],
    )).toEqual([])
  })

  test('the outline check now runs the spine check, because that is where it lives', () => {
    const problems = outlineGroundingProblems({
      modules: modules.map((module) => ({ ...module, summary: 's', sourceIds: [] })),
      moduleDependencies: [dep('m1', 'ghost')],
    })
    expect(problems.some((problem) => problem.includes('not in the outline'))).toBe(true)
  })

  test('an outline with a clean spine reports nothing about it', () => {
    expect(outlineGroundingProblems({
      modules: modules.map((module) => ({ ...module, topics: ['a', 'b'], summary: 's', sourceIds: [] })),
      moduleDependencies: [dep('m1', 'm0'), dep('m2', 'm1')],
    })).toEqual([])
  })
})

describe('the whole-graph edge pass is checked against the concepts that exist', () => {
  const known = [
    { name: 'Asymptotic growth', laneId: 'foundations' },
    { name: 'Master theorem', laneId: 'foundations' },
    { name: 'Adjacency list', laneId: 'graphs' },
    { name: 'Breadth-first search', laneId: 'graphs' },
  ]
  const edge = (from: string, to: string, kind: 'hard-prerequisite' | 'related' = 'hard-prerequisite') =>
    ({ fromConcept: from, toConcept: to, kind, confidence: 0.8 })

  test('an edge joining two lanes is exactly what the pass is for, and passes clean', () => {
    expect(conceptEdgeGroundingProblems(known, [edge('Asymptotic growth', 'Breadth-first search')])).toEqual([])
  })

  test('an endpoint naming no written concept is refused, not silently dropped', () => {
    // The writer would discard this edge without a word, so a reply that
    // invented half its endpoints would read as a thin answer rather than a
    // wrong one — and the retry, the only place the model can still be told,
    // would never run.
    const problems = conceptEdgeGroundingProblems(known, [edge('Asymptotic growth', 'Dijkstra')])
    expect(problems.join(' ')).toContain('"Dijkstra"')
    expect(problems.join(' ')).toContain('cannot introduce a concept')
  })

  test('endpoints are matched case- and space-insensitively, so a stray capital is not a hallucination', () => {
    expect(conceptEdgeGroundingProblems(known, [edge('  asymptotic GROWTH ', 'Breadth-first search')])).toEqual([])
  })

  test('a concept joined to itself is refused', () => {
    expect(conceptEdgeGroundingProblems(known, [edge('Master theorem', 'master theorem')]).join(' '))
      .toContain('joined to itself')
  })

  test('a reply with no cross-lane edge at all has done the lane pass over again', () => {
    // This is the specific failure the pass exists to catch: the within-lane
    // edges were already written by the lane calls, so a whole-graph call that
    // returns only more of them added nothing.
    const problems = conceptEdgeGroundingProblems(known, [
      edge('Asymptotic growth', 'Master theorem'),
      edge('Adjacency list', 'Breadth-first search'),
    ])
    expect(problems.join(' ')).toContain('joins two different lanes')
  })

  test('a ONE-LANE curriculum is exempt: it has no cross-lane edge to find', () => {
    const oneLane = known.map((concept) => ({ ...concept, laneId: 'foundations' }))
    expect(conceptEdgeGroundingProblems(oneLane, [edge('Asymptotic growth', 'Master theorem')])).toEqual([])
  })

  test('no edges at all still trips the cross-lane check rather than passing as "nothing wrong"', () => {
    expect(conceptEdgeGroundingProblems(known, []).join(' ')).toContain('joins two different lanes')
  })
})

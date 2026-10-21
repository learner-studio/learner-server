import { describe, expect, test } from 'bun:test'
import {
  CONCEPT_EDGE_SCHEMA,
  CONCEPT_SCHEMA,
  OBJECTIVE_PLAN_SCHEMA,
  OUTLINE_SCHEMA,
  buildConceptEdgePrompt,
  buildLaneConceptPrompt,
  buildObjectivePlanPrompt,
  buildOutlinePrompt,
  materialExcerpt,
} from './curriculum-prompts.js'
import {
  CONCEPTS_PER_TOPIC,
  CURRICULUM_SCALE_LIMITS,
  CurriculumGraphProposal,
  CurriculumObjectivePlan,
  CurriculumOutline,
  type CurriculumMaterial,
  type CurriculumObjectivePlan as Plan,
} from './curriculum-generation-types.js'

const plan = (over: Partial<Plan> = {}): Plan => ({
  domain: 'algorithms', scale: 'course', queries: ['data structures'], providers: ['mit-ocw'],
  restated: 'Understand how algorithms are analysed.', ...over,
})

const material = (markdown: string, over: Partial<CurriculumMaterial['source']> = {}): CurriculumMaterial => ({
  source: {
    sourceId: 'mit-ocw:6-006', provider: 'mit-ocw', title: 'Introduction to Algorithms',
    url: 'https://ocw.mit.edu/courses/6-006/', licence: 'CC BY-NC-SA 4.0',
    attribution: 'MIT OpenCourseWare', retrievedAt: '2026-09-09T00:00:00.000Z',
    contentChars: markdown.length, ...over,
  },
  markdown,
})

describe('the schemas the model is constrained to', () => {
  test('each is derived from the Zod contract that validates the reply', () => {
    // Hand-writing these would drift on the first field added, and the drift
    // shows up as a parse failure blamed on the model.
    expect(JSON.stringify(OBJECTIVE_PLAN_SCHEMA)).toContain('providers')
    expect(JSON.stringify(OUTLINE_SCHEMA)).toContain('sourceIds')
    expect(JSON.stringify(OUTLINE_SCHEMA)).toContain('moduleDependencies')
    expect(() => CurriculumObjectivePlan.parse({ ...plan() })).not.toThrow()
    expect(() => CurriculumOutline.parse({ title: 'x' })).toThrow()
    expect(() => CurriculumGraphProposal.parse({ moduleDependencies: 'none' })).toThrow()
  })
})

describe('the objective prompt asks for searchable subject names', () => {
  const prompt = buildObjectivePlanPrompt('I want to understand computer science')

  test('it forbids goal-shaped queries', () => {
    // Measured 2026-09-09: "most specific first" alone produced phrases like
    // "computing systems engineering", which MIT's search matches against
    // descriptions — eight candidates came back, none of them computer science.
    expect(prompt).toContain('SUBJECT NAMES')
    expect(prompt).toMatch(/Never a verb, a skill, or a sentence/)
  })

  test('it carries the learner\'s own words, unparaphrased', () => {
    expect(prompt).toContain('I want to understand computer science')
  })

  test('scale defaults toward the smaller answer when torn', () => {
    // A learner can ask for more; they cannot easily find the answer inside
    // twenty modules they did not want.
    expect(prompt).toContain('choose "course"')
  })
})

describe('the outline prompt is what decides the shape of the tree', () => {
  const prompt = buildOutlinePrompt('understand algorithms', plan(), [material('# Calendar\n\nWeek 1: asymptotics')])

  test('it forbids evening the modules out', () => {
    // The load-bearing rule of the whole comparison. The hand-authored seed
    // gives 86.5% of its modules exactly five concepts; if a syllabus-grounded
    // curriculum comes back that regular, the grounding changed the words and
    // not the shape.
    expect(prompt).toContain('Do NOT even the modules out')
    expect(prompt).toContain('template wearing a syllabus')
  })

  test('a module is a subject, not a calendar row', () => {
    // Measured 2026-09-09: transcribing a session-per-meeting calendar
    // literally produced 54 modules of which 41 held exactly one topic, and
    // module titles like "Recovery" appearing twice because the course met
    // twice on it.
    expect(prompt).toContain('A MODULE IS A SUBJECT, NOT A CALENDAR ENTRY')
    expect(prompt).toContain('the session titles become its topics')
  })

  test('it drops the sessions a learner cannot master', () => {
    // The same run produced modules called "Quiz 1 Review", "Tutorial: Project
    // Office Hours" (twice) and "Final project presentations".
    expect(prompt).toContain('DROP everything that is not teaching')
    expect(prompt).toMatch(/office hours/i)
  })

  test('grouping sessions never overrides the source\'s own units', () => {
    // Rules 1 and 3 pull in opposite directions on a source that declares
    // units. The prompt has to say which wins, or an unevenly-unitised
    // syllabus gets regrouped into tidy modules — the failure rule 2 forbids.
    expect(prompt).toContain('This does NOT override')
  })

  test('an invented module must not cite a source', () => {
    // groundedShare is measured from these citations, so a false one destroys
    // the only evidence of what was transcribed rather than authored.
    expect(prompt).toContain('EMPTY sourceIds list')
  })

  test('the scale limits reaching the model are the ones the writer enforces', () => {
    // The writer rejects an outline outside these bounds, so a prompt naming
    // different numbers would produce a run that fails only at the last step.
    const limits = CURRICULUM_SCALE_LIMITS.course
    expect(prompt).toContain(`between ${limits.minModules} and ${limits.maxModules} modules`)
    expect(buildOutlinePrompt('x', plan({ scale: 'curriculum' }), [material('m')]))
      .toContain(`between ${CURRICULUM_SCALE_LIMITS.curriculum.minModules}`)
  })

  test('every source arrives with the ID the model must cite and its licence', () => {
    expect(prompt).toContain('ID: mit-ocw:6-006')
    expect(prompt).toContain('CC BY-NC-SA 4.0')
    expect(prompt).toContain('Week 1: asymptotics')
  })

  test('two sources are both presented, each with its own ID', () => {
    const two = buildOutlinePrompt('x', plan(), [
      material('first body'),
      material('second body', { sourceId: 'mit-ocw:6-046j', title: 'Design and Analysis of Algorithms' }),
    ])
    expect(two).toContain('mit-ocw:6-006')
    expect(two).toContain('mit-ocw:6-046j')
    expect(two).toContain('second body')
  })
})

describe('oversized material', () => {
  test('is trimmed from the END and says so', () => {
    // Every provider puts the outline first and the grading policy, licence
    // and site chrome after it, so the tail is the safe side to lose. The
    // marker matters: silent truncation reads to the model as a course that
    // simply stops.
    const excerpt = materialExcerpt(material('a'.repeat(100)), 20)
    expect(excerpt.startsWith('a'.repeat(20))).toBe(true)
    expect(excerpt).toContain('truncated')
  })

  test('material within budget is passed through untouched', () => {
    expect(materialExcerpt(material('short'), 20)).toBe('short')
  })
})

describe('the outline prompt now carries the prerequisite spine too', () => {
  // Folded in on 2026-09-11. It was its own call because a prerequisite is one
  // line where a concept is four sentences — but that is the argument for
  // keeping the CONCEPT calls split, never an argument for asking a second
  // model to re-derive an ordering the outline author already had in mind.
  const prompt = buildOutlinePrompt('understand algorithms', plan(), [material('# 6.006\n\nWeek 1: asymptotics')], 4000)

  test('it asks for moduleDependencies in the same reply as the lanes', () => {
    expect(prompt).toContain('moduleDependencies')
    expect(prompt).toContain('module ids YOU')
  })

  test('it keeps the rules that made the separate call worth having', () => {
    // Dropping these when folding would trade a call for a worse answer: an
    // unconstrained model returns a single chain at uniform confidence.
    expect(prompt).toContain('Only genuine prerequisites')
    expect(prompt).toContain('Uniform confidences')
    expect(prompt).toContain('No circles')
  })

  test('it still does not ask for concepts, which remain their own calls', () => {
    // The split that survives is by OUTPUT VOLUME. Prose cannot join this call.
    expect(prompt).not.toContain('conceptEdges')
    expect(prompt).not.toContain('explanation: two to four sentences')
  })

  test('the outline schema is the one contract carrying both halves', () => {
    expect(JSON.stringify(OUTLINE_SCHEMA)).toContain('moduleDependencies')
    expect(JSON.stringify(OUTLINE_SCHEMA)).not.toContain('conceptEdges')
    expect(JSON.stringify(CONCEPT_SCHEMA)).toContain('conceptEdges')
    expect(JSON.stringify(CONCEPT_SCHEMA)).not.toContain('moduleDependencies')
  })

  test('an outline stored before the fold still parses, defaulting to no spine', () => {
    // Outlines live in JSONB on the run row. A required array would make every
    // run written before 2026-09-11 fail to re-approve or rebuild.
    const old = CurriculumOutline.parse({
      title: 'Algorithms', description: 'd', domain: 'algorithms', scale: 'course',
      lanes: [{ id: 'l0', title: 'Foundations', summary: 's' }],
      modules: [{ id: 'm0', laneId: 'l0', title: 'Asymptotics', summary: 's', topics: ['Big-O'], sourceIds: [] }],
    })
    expect(old.moduleDependencies).toEqual([])
  })
})

describe('the lane concept prompt asks for one lane and no more', () => {
  const outline = CurriculumOutline.parse({
    title: 'Algorithms', description: 'd', domain: 'algorithms', scale: 'course',
    lanes: [
      { id: 'l0', title: 'Foundations', summary: 'the base' },
      { id: 'l1', title: 'Graphs', summary: 'later' },
    ],
    modules: [
      { id: 'm0', laneId: 'l0', title: 'Asymptotics', summary: 's', topics: ['Big-O'], sourceIds: [] },
      { id: 'm1', laneId: 'l1', title: 'Traversal', summary: 's', topics: ['Breadth-first search'], sourceIds: [] },
    ],
  })

  test('it carries the lane\'s own modules with their topics, because concepts are inferred from them', () => {
    const prompt = buildLaneConceptPrompt(outline, 'l0')
    expect(prompt).toContain('Foundations')
    expect(prompt).toContain('Asymptotics')
    expect(prompt).toContain('Big-O')
  })

  test('it asks for SEVERAL concepts per topic, which is the whole point of the step', () => {
    // The prompt used to say "one entry for EVERY topic", which made the
    // concept network a copy of the skill tree — measured at 1.4-1.8 concepts
    // per module against the seed curriculum's 4.99.
    const prompt = buildLaneConceptPrompt(outline, 'l0')
    expect(prompt).toContain(`write ${CONCEPTS_PER_TOPIC.min} to ${CONCEPTS_PER_TOPIC.max}`)
    expect(prompt).toContain('A TOPIC IS A LESSON. A CONCEPT IS ONE IDEA TAUGHT INSIDE IT')
    expect(prompt).toContain('has returned the skill tree again under a second name')
  })

  test('concepts already written in EARLIER lanes are offered as edge endpoints, not as work', () => {
    // A concept edge may legitimately cross lanes, and a call that cannot see
    // the other endpoint cannot propose the edge. The endpoints are the earlier
    // lanes' CONCEPT NAMES, not their topics: a topic now resolves to three to
    // eight concepts and so cannot name one.
    const prompt = buildLaneConceptPrompt(outline, 'l0', [
      { moduleId: 'm1', name: 'Frontier queue' },
      { moduleId: 'm1', name: 'Visited set' },
    ])
    expect(prompt).toContain('Frontier queue')
    expect(prompt).toContain('Visited set')
    expect(prompt).toContain('do NOT write concepts for them')
    expect(prompt).toContain('Write NOTHING for a module in another lane')
  })

  test('the FIRST lane is told there is nothing to link out to yet, rather than shown an empty list', () => {
    // Lanes run serially, so the first one genuinely has no cross-lane endpoint
    // available. That is correct rather than lossy — the later lane draws the join.
    expect(buildLaneConceptPrompt(outline, 'l0')).toContain('no other lane has been written yet')
  })

  test('another lane\'s TOPICS are never offered, because they no longer name a concept', () => {
    const prompt = buildLaneConceptPrompt(outline, 'l0')
    expect(prompt).not.toContain('Breadth-first search')
  })
})

describe('the lane concept prompt is handed the whole spine, not just its own lane', () => {
  // The split is forced by how much prose has to come back; it is NOT a reason
  // for a lane call to be ignorant. Input is the cheap half — one line per
  // prerequisite — so every split call sees the full structure.
  const outline = CurriculumOutline.parse({
    title: 'Algorithms', description: 'd', domain: 'algorithms', scale: 'course',
    lanes: [
      { id: 'l0', title: 'Foundations', summary: 'the base' },
      { id: 'l1', title: 'Graphs', summary: 'later' },
    ],
    modules: [
      { id: 'm0', laneId: 'l0', title: 'Asymptotics', summary: 's', topics: ['Big-O'], sourceIds: [] },
      { id: 'm1', laneId: 'l1', title: 'Traversal', summary: 's', topics: ['BFS'], sourceIds: [] },
      { id: 'm2', laneId: 'l1', title: 'Shortest paths', summary: 's', topics: ['Dijkstra'], sourceIds: [] },
    ],
    moduleDependencies: [
      { moduleId: 'm1', dependsOnModuleId: 'm0', confidence: 0.9, rationale: 'Traversal costs are stated in Big-O.' },
      { moduleId: 'm2', dependsOnModuleId: 'm1', confidence: 0.8, rationale: 'Dijkstra is a traversal.' },
    ],
  })

  test('a lane sees prerequisites that do not touch it at all', () => {
    // m1 -> m2 is entirely inside lane l1, and the l0 call is still told about
    // it: the macro shape is what makes a concept edge plausible or not.
    const prompt = buildLaneConceptPrompt(outline, 'l0')
    expect(prompt).toContain('PREREQUISITE SPINE')
    expect(prompt).toContain('Traversal')
    expect(prompt).toContain('Shortest paths')
  })

  test('the edges that touch this lane are marked, because those are the joinable ones', () => {
    const prompt = buildLaneConceptPrompt(outline, 'l0')
    const marked = prompt.split('\n').filter((line) => line.startsWith('>> '))
    expect(marked).toHaveLength(1)
    expect(marked[0]).toContain('Asymptotics')
    expect(marked[0]).toContain('BEFORE')
  })

  test('the rationale travels with the edge, so the call knows WHY it was drawn', () => {
    // Without it the prompt says only that m1 follows m0, which a concept
    // writer cannot turn into a specific concept-to-concept edge.
    expect(buildLaneConceptPrompt(outline, 'l1')).toContain('Traversal costs are stated in Big-O.')
  })

  test('the call is told to substantiate a module prerequisite with a concept edge', () => {
    expect(buildLaneConceptPrompt(outline, 'l1')).toContain('Start from the >> lines')
    expect(buildLaneConceptPrompt(outline, 'l1')).toContain('failed to substantiate')
  })

  test('an outline with no spine says so rather than rendering an empty heading', () => {
    const bare = CurriculumOutline.parse({
      title: 'Algorithms', description: 'd', domain: 'algorithms', scale: 'course',
      lanes: [{ id: 'l0', title: 'Foundations', summary: 's' }],
      modules: [{ id: 'm0', laneId: 'l0', title: 'Asymptotics', summary: 's', topics: ['Big-O'], sourceIds: [] }],
    })
    expect(buildLaneConceptPrompt(bare, 'l0')).toContain('states no prerequisites')
    expect(buildLaneConceptPrompt(bare, 'l0')).not.toContain('PREREQUISITE SPINE')
  })
})

describe('a topic list must not read as one topic', () => {
  test('each topic is on its own line, so a topic containing a semicolon still reads as one topic', () => {
    // Run 9b005d78: topics were joined with '; ', a module whose topics were
    // "QoS-I: Why QoS" and "Basic Models and Architecture" rendered as a single
    // string, and the model copied that string back as one concept. A
    // separator that can appear inside the values it separates is not one.
    const outline = CurriculumOutline.parse({
      title: 'Computer Networks', description: 'd', domain: 'networks', scale: 'course',
      lanes: [{ id: 'l0', title: 'QoS', summary: 's' }],
      modules: [{
        id: 'net-l13', laneId: 'l0', title: 'QoS-I: Why QoS; Basic Models and Architecture', summary: 's',
        topics: ['QoS-I: Why QoS', 'Basic Models and Architecture'], sourceIds: [],
      }],
    })
    // The lane prompt is now the only one that renders an existing outline —
    // the outline prompt renders SOURCES, and the dependency prompt that used
    // to share this rendering was folded into it on 2026-09-11.
    const prompt = buildLaneConceptPrompt(outline, 'l0')
    expect(prompt).toContain('    - QoS-I: Why QoS\n    - Basic Models and Architecture')
    expect(prompt).not.toContain('topics: QoS-I: Why QoS; Basic Models and Architecture')
    expect(prompt).toContain('Never invent one, never join two')
  })
})

describe('the whole-graph edge prompt sees every lane at once', () => {
  const outline = CurriculumOutline.parse({
    title: 'Algorithms', description: 'd', domain: 'algorithms', scale: 'course',
    lanes: [
      { id: 'foundations', title: 'Foundations', summary: 'Groundwork.' },
      { id: 'graphs', title: 'Graphs', summary: 'Graph algorithms.' },
    ],
    modules: [
      { id: 'm0', laneId: 'foundations', title: 'Asymptotics', summary: 's', topics: ['Big-O'], sourceIds: [] },
      { id: 'm1', laneId: 'graphs', title: 'Traversal', summary: 's', topics: ['BFS'], sourceIds: [] },
    ],
  })
  const known = [
    { moduleId: 'm0', name: 'Asymptotic growth' },
    { moduleId: 'm1', name: 'Breadth-first search' },
  ]
  const prompt = buildConceptEdgePrompt(outline, known)

  test('its schema is the edge-only contract, carrying no concept fields', () => {
    // The affordability of this call is the whole reason it exists: the lane
    // calls send four sentences per concept, this one sends a name per line.
    // A schema that still admitted `explanation` would invite the model to
    // rewrite the concepts and put the payload straight back.
    const schema = JSON.stringify(CONCEPT_EDGE_SCHEMA)
    expect(schema).toContain('conceptEdges')
    expect(schema).not.toContain('explanation')
    expect(schema).not.toContain('capability')
  })

  test('every concept in the curriculum is listed, grouped under its lane', () => {
    expect(prompt).toContain('LANE: Foundations')
    expect(prompt).toContain('LANE: Graphs')
    expect(prompt).toContain('    - Asymptotic growth')
    expect(prompt).toContain('    - Breadth-first search')
  })

  test('it carries no concept PROSE — that is what makes one whole-graph call affordable', () => {
    // Run ee00295d died at the CLI's 394s kill timer asking one call for
    // concepts plus prose plus edges; the securities lane alone took 405s on
    // 2026-09-10. This call is names in, tuples out.
    expect(prompt).not.toContain('explanation')
    expect(prompt).not.toContain('two to four sentences')
    expect(prompt).toContain('Write NO concepts')
  })

  test('it points the model at the cross-lane joins, which are the only thing it adds', () => {
    expect(prompt).toContain('BETWEEN LANES')
    expect(prompt).toContain('could not see each other')
  })

  test('it refuses padding, because every edge claims something', () => {
    expect(prompt).toContain('Do not manufacture edges to hit a count')
  })

  test('endpoints must be copied literally, since an invented one is dropped', () => {
    expect(prompt).toContain('dropped')
    expect(prompt).toContain('copy them literally')
  })
})

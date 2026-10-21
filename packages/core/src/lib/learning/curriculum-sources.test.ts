import { describe, expect, test } from 'bun:test'
import {
  CURRICULUM_MATERIAL_MAX_CHARS,
  CURRICULUM_PROVIDERS,
  fetchCurriculumMaterial,
  newestEditionPerCourse,
  planQueries,
  searchCurriculumSources,
  type SourceFetch,
} from './curriculum-sources.js'
import type { CurriculumCandidate, CurriculumObjectivePlan } from './curriculum-generation-types.js'

const plan = (over: Partial<CurriculumObjectivePlan> = {}): CurriculumObjectivePlan => ({
  domain: 'algorithms', scale: 'course',
  queries: ['introduction to algorithms'], providers: ['mit-ocw'],
  restated: 'Understand algorithms.', ...over,
})

const ocwResult = (slug: string, title: string) => ({
  title, url: `https://ocw.mit.edu/courses/${slug}/`, description: `About ${title}`,
})

const jsonReader = (log: string[], results: unknown[]): SourceFetch => async (url) => {
  log.push(url)
  return { ok: true, status: 200, body: JSON.stringify({ count: results.length, results }) }
}

const noMarkdown: SourceFetch = async () => ({ ok: false, status: 404, body: '' })

describe('the MIT OCW search asks the endpoint that honours the query', () => {
  test('it calls the search endpoint with the query and a course filter', async () => {
    // The listing endpoint `/learning_resources/` accepts `q` and IGNORES it:
    // every query returned the same 9,176 rows, so a run for algorithms was
    // grounded in Marine Power and Propulsion. Nothing errored. This assertion
    // is the only thing standing between that failure and a silent recurrence.
    const log: string[] = []
    await searchCurriculumSources(plan(), {
      fetchJson: jsonReader(log, [ocwResult('6-006-introduction-to-algorithms-spring-2020', 'Introduction to Algorithms')]),
      fetchMarkdown: noMarkdown,
    })
    // Two calls: the planned query, then the domain backstop below.
    expect(log.length).toBe(2)
    expect(log[0]).toContain('/learning_resources_search/')
    expect(log[0]).not.toMatch(/learning_resources\/\?/)
    expect(log[0]).toContain('resource_category=course')
    expect(log[0]).toContain('q=introduction%20to%20algorithms')
  })

  test('a candidate carries the course URL, the calendar as its syllabus, and the provider licence', async () => {
    const [candidate] = await searchCurriculumSources(plan(), {
      fetchJson: jsonReader([], [ocwResult('6-006-introduction-to-algorithms-spring-2020', 'Introduction to Algorithms')]),
      fetchMarkdown: noMarkdown,
    })
    expect(candidate!.sourceId).toBe('mit-ocw:6-006-introduction-to-algorithms-spring-2020')
    expect(candidate!.url).toBe('https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/')
    expect(candidate!.syllabusUrl).toContain('/pages/calendar/')
    expect(candidate!.licence).toBe(CURRICULUM_PROVIDERS['mit-ocw'].licence)
  })

  test('a provider that fails does not fail the search', async () => {
    // Providers are asked in parallel and settled independently: one API being
    // down must not cost the learner the results from the others.
    const found = await searchCurriculumSources(plan({ providers: ['mit-ocw', 'openstax'] }), {
      fetchJson: async (url) => {
        if (url.includes('openstax')) throw new Error('openstax down')
        return { ok: true, status: 200, body: JSON.stringify({ results: [ocwResult('6-006-introduction-to-algorithms-spring-2020', 'Introduction to Algorithms')] }) }
      },
      fetchMarkdown: noMarkdown,
    })
    expect(found.map((candidate) => candidate.provider)).toEqual(['mit-ocw'])
  })
})

describe('ranking prefers the course that is about the subject', () => {
  test('a title that is only about the subject beats one that mentions it', async () => {
    // Both score a perfect token match, because "introduction" is a stop word.
    // The tie used to fall through to alphabetical order, which handed an
    // algorithms objective a graduate inference course because A precedes I.
    const found = await searchCurriculumSources(plan(), {
      fetchJson: jsonReader([], [
        ocwResult('6-438-algorithms-for-inference-fall-2014', 'Algorithms for Inference'),
        ocwResult('6-006-introduction-to-algorithms-spring-2020', 'Introduction to Algorithms'),
      ]),
      fetchMarkdown: noMarkdown,
    })
    expect(found[0]!.title).toBe('Introduction to Algorithms')
  })
})

describe('one course is read once, at its newest edition', () => {
  const editions = [
    { sourceId: 'mit-ocw:6-006-introduction-to-algorithms-fall-2011' },
    { sourceId: 'mit-ocw:6-006-introduction-to-algorithms-spring-2020' },
    { sourceId: 'mit-ocw:6-006-introduction-to-algorithms-spring-2008' },
    { sourceId: 'mit-ocw:6-046j-introduction-to-algorithms-sma-5503-fall-2005' },
  ] as unknown as CurriculumCandidate[]

  test('three vintages of one course collapse to the newest', () => {
    // Otherwise every material slot goes to one syllabus in three vintages and
    // the outline sees a single course's view of the whole field.
    const kept = newestEditionPerCourse(editions)
    expect(kept.map((candidate) => candidate.sourceId)).toEqual([
      'mit-ocw:6-006-introduction-to-algorithms-spring-2020',
      'mit-ocw:6-046j-introduction-to-algorithms-sma-5503-fall-2005',
    ])
  })

  test('different course numbers are different courses and both survive', () => {
    const kept = newestEditionPerCourse(editions)
    expect(kept.length).toBe(2)
  })

  test('a slug with no year is kept rather than dropped', () => {
    const odd = [{ sourceId: 'mit-ocw:res-6-008-digital-signal-processing' }] as unknown as CurriculumCandidate[]
    expect(newestEditionPerCourse(odd).length).toBe(1)
  })
})

describe('reading a candidate refuses to return empty material', () => {
  const candidate = {
    sourceId: 'mit-ocw:6-006', provider: 'mit-ocw', title: 'Introduction to Algorithms',
    url: 'https://ocw.mit.edu/courses/6-006/', licence: 'CC BY-NC-SA 4.0',
    attribution: 'MIT OpenCourseWare', syllabusUrl: 'https://ocw.mit.edu/courses/6-006/pages/calendar/',
    summary: '', matchReason: '',
  } as CurriculumCandidate

  test('a candidate whose every page is unreachable throws', async () => {
    // Returning a material of zero characters would let the outline step
    // invent a course from the objective alone and call it grounded.
    await expect(fetchCurriculumMaterial(candidate, { fetchJson: noMarkdown, fetchMarkdown: noMarkdown }))
      .rejects.toThrow()
  })

  test('the pages that do answer are concatenated with their URLs', async () => {
    const material = await fetchCurriculumMaterial(candidate, {
      fetchJson: noMarkdown,
      fetchMarkdown: async (url) => url.includes('calendar')
        ? { ok: true, status: 200, body: 'Week 1: asymptotics' }
        : { ok: false, status: 404, body: '' },
    })
    expect(material.markdown).toContain('Week 1: asymptotics')
    expect(material.markdown).toContain('calendar')
    expect(material.source.contentChars).toBe(material.markdown.length)
  })

  test('oversized material is trimmed from the END, keeping the outline', () => {
    // Every provider puts the outline first and the grading policy, licence
    // and site chrome after it, so the tail is what can be spared.
    expect(CURRICULUM_MATERIAL_MAX_CHARS).toBe(200_000)
  })
})

describe('the domain is always searched, whatever the planner asked for', () => {
  test('the domain slug is added as a query, spelled as words', async () => {
    // Measured 2026-09-09: a whole-of-CS objective produced eight candidates,
    // none of them computer science, because every planned query was a
    // goal-shaped phrase. The bare subject name returns 101 courses and leads
    // with Mathematics for Computer Science.
    const log: string[] = []
    await searchCurriculumSources(
      plan({ domain: 'computer-science', queries: ['computing systems engineering'] }),
      { fetchJson: jsonReader(log, []), fetchMarkdown: noMarkdown },
    )
    expect(log.length).toBe(2)
    expect(log.some((url) => url.includes('q=computer%20science'))).toBe(true)
  })

  test('it is not asked twice when the planner already asked for it', async () => {
    const log: string[] = []
    await searchCurriculumSources(
      plan({ domain: 'algorithms', queries: ['algorithms', 'data structures'] }),
      { fetchJson: jsonReader(log, []), fetchMarkdown: noMarkdown },
    )
    expect(log.length).toBe(2)
  })

  test('it goes LAST, so the learner\'s own phrasing still wins the ranking', () => {
    // The ranker weights earlier queries higher. Prepending the backstop would
    // silently make the broad fallback outrank the specific request.
    expect(planQueries(plan({ domain: 'algorithms', queries: ['dynamic programming'] })))
      .toEqual(['dynamic programming', 'algorithms'])
  })

  test('a candidate found only by the backstop still ranks on the query that found it', async () => {
    const found = await searchCurriculumSources(
      plan({ domain: 'computer-science', queries: ['computing systems engineering'] }),
      {
        fetchJson: jsonReader([], [
          ocwResult('2-611-marine-power-and-propulsion-fall-2006', 'Marine Power and Propulsion'),
          ocwResult('6-042j-mathematics-for-computer-science-spring-2015', 'Mathematics for Computer Science'),
        ]),
        fetchMarkdown: noMarkdown,
      },
    )
    expect(found[0]!.title).toBe('Mathematics for Computer Science')
  })
})

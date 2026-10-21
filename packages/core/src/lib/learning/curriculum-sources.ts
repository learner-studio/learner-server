import type {
  CurriculumCandidate,
  CurriculumMaterial,
  CurriculumObjectivePlan,
  CurriculumProvider,
} from './curriculum-generation-types.js'

/**
 * Search and read clients for the openly-licensed course providers the
 * curriculum pipeline is allowed to learn from.
 *
 * Every network call goes through the injected `deps`, never a global fetch.
 * That is what keeps the unit tests pure, and it is also how the probe
 * scenario hands in the sanctioned crawler (`CloudflareCrawlClient` and the
 * Browser Rendering `/markdown` endpoint) without this module knowing about
 * Cloudflare credentials, modes or budgets. A provider client that fetched on
 * its own would be a second crawl path to gate and pay for.
 *
 * Provider facts (endpoints, licences, what each one can and cannot serve)
 * were verified against the live services on 2026-09-09. Do not add an
 * endpoint here from memory: two of the obvious ones (learn.saylor.org course
 * pages, OpenStax book repos guessed from a slug) are known not to work.
 */

export type CurriculumProviderInfo = {
  readonly provider: CurriculumProvider
  readonly label: string
  readonly licence: string
  readonly attribution: string
  readonly homepage: string
  /** Why this provider may be read automatically. */
  readonly termsNote: string
}

export const CURRICULUM_PROVIDERS: Readonly<Record<CurriculumProvider, CurriculumProviderInfo>> = {
  'mit-ocw': {
    provider: 'mit-ocw',
    label: 'MIT OpenCourseWare',
    licence: 'CC BY-NC-SA 4.0',
    attribution: 'MIT OpenCourseWare',
    homepage: 'https://ocw.mit.edu/',
    termsNote: 'robots.txt allows all; the OCW terms explicitly permit AI use under the CC BY-NC-SA licence terms.',
  },
  openstax: {
    provider: 'openstax',
    label: 'OpenStax',
    licence: 'CC BY 4.0',
    attribution: 'OpenStax',
    homepage: 'https://openstax.org/',
    termsNote: 'Books are CC BY 4.0 and the catalogue is a public, unauthenticated CMS API.',
  },
  saylor: {
    provider: 'saylor',
    label: 'Saylor Academy',
    licence: 'CC BY 4.0',
    attribution: 'Saylor Academy',
    homepage: 'https://www.saylor.org/',
    termsNote: 'Courses are CC BY 4.0 and published as a bulk export on GitHub; learn.saylor.org itself refuses guest access, so it is never fetched.',
  },
  ossu: {
    provider: 'ossu',
    label: 'Open Source Society University',
    licence: 'MIT',
    attribution: 'Open Source Society University',
    homepage: 'https://github.com/ossu/computer-science',
    termsNote: 'MIT-licensed public repository; the README is the whole curriculum, prerequisites included.',
  },
  'open-textbook-library': {
    provider: 'open-textbook-library',
    label: 'Open Textbook Library',
    licence: 'CC0 metadata',
    attribution: 'Open Textbook Library',
    homepage: 'https://open.umn.edu/opentextbooks/',
    termsNote: 'Catalogue metadata is CC0 over an unauthenticated JSON endpoint; each book carries its own licence, so this is discovery only.',
  },
}

export type SourceFetch = (url: string) => Promise<{ ok: boolean; status: number; body: string }>

type SearchDeps = { fetchJson: SourceFetch; fetchMarkdown: SourceFetch; limit?: number }
type FetchDeps = { fetchJson: SourceFetch; fetchMarkdown: SourceFetch }

/**
 * Hard ceiling on material handed to the outline step. The downstream model
 * call has an input budget, and an MIT calendar page plus syllabus can run
 * well past it once the crawler renders navigation and footers. We trim from
 * the END because every provider puts the outline before the boilerplate:
 * the calendar table, the chapter list and the README's course table all come
 * first, and what follows is grading policy, licences and site chrome.
 */
export const CURRICULUM_MATERIAL_MAX_CHARS = 200_000

const DEFAULT_LIMIT = 8

/**
 * The SEARCH endpoint, not the listing endpoint.
 *
 * `/learning_resources/` accepts a `q` parameter and silently IGNORES it: every
 * query returns the same 9,176 resources in the same order, so a search for
 * "introduction to algorithms" came back with Marine Power and Propulsion and
 * American History to 1865 (measured 2026-09-09). Nothing errors — the run just
 * grounds a curriculum in whatever the catalogue happens to list first.
 * `/learning_resources_search/` honours `q`, and `resource_category=course`
 * keeps courses rather than the individual lecture videos inside them.
 */
const MIT_LEARN_API = 'https://api.learn.mit.edu/api/v1/learning_resources_search/'
const MIT_OCW_COURSES = 'https://ocw.mit.edu/courses/'
const OPENSTAX_BOOKS_API = 'https://openstax.org/apps/cms/api/v2/pages/?type=books.Book&fields=title,license_name,license_version&limit=200'
const OPENSTAX_BOOK_PAGE = 'https://openstax.org/details/books/'
const SAYLOR_BACKUPS_API = 'https://api.github.com/repos/saylordotorg/course_backups/contents/'
const SAYLOR_BACKUPS_REPO = 'https://github.com/saylordotorg/course_backups'
const OSSU_REPO = 'https://github.com/ossu/computer-science'
const OSSU_README = 'https://raw.githubusercontent.com/ossu/computer-science/master/README.md'
const OTL_CATALOGUE = 'https://open.umn.edu/opentextbooks/textbooks.json?page=1'
const OTL_BOOK_PAGE = 'https://open.umn.edu/opentextbooks/textbooks/'

/**
 * Search every provider in the plan and return candidates ranked best-first.
 *
 * Providers are asked in parallel and each one is isolated: a provider that
 * throws, times out, answers with a non-2xx status or returns malformed JSON
 * contributes nothing and the others still answer. That is deliberate. The
 * run's job is to find SOME published outline; failing it because one CDN was
 * down would turn a partial answer into no answer, and the outline step
 * already reports which sources it was grounded in, so a missing provider is
 * visible without being fatal. Nothing is logged here because this is a pure
 * library function with no logger in its deps; the caller can compare the
 * returned providers against `plan.providers` if it wants to report a gap.
 *
 * Ranking is by what the provider can actually give the outline step, not by
 * how well the title matched. MIT OCW is the only provider with a
 * session-by-session outline, so a weak OCW match still beats a perfect
 * textbook-catalogue match: the outline step can transcribe a calendar, but
 * it cannot transcribe a title. Within the same outline depth the more
 * permissive licence wins, because the tree attributes per node and a CC BY
 * node owes less than a CC BY-NC-SA one. Title match decides only ties.
 */
export async function searchCurriculumSources(
  plan: CurriculumObjectivePlan,
  deps: SearchDeps,
): Promise<CurriculumCandidate[]> {
  const limit = deps.limit ?? DEFAULT_LIMIT
  const wanted = new Set<CurriculumProvider>(plan.providers)
  const settled = await Promise.allSettled(
    [...wanted].map((provider) => PROVIDER_SEARCHERS[provider](plan, deps, limit)),
  )
  const found = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
  // The searcher table is keyed by provider, but a searcher is still the only
  // thing that sets `provider` on a candidate, so the filter is the guarantee
  // rather than a formality: it holds even if a future searcher delegates.
  const allowed = found.filter((candidate) => wanted.has(candidate.provider))
  return rankCandidates(dedupeBySourceId(allowed), plan).slice(0, limit)
}

/**
 * Read one candidate's syllabus/outline into markdown.
 *
 * Each provider keeps its outline somewhere different, so the read is a short
 * ordered list of URLs per provider rather than "fetch the candidate URL":
 * for MIT OCW the calendar page is the outline and the syllabus page is the
 * framing, and both are read so the outline step sees session order AND the
 * course's own description of its units. The first URL that answers with a
 * body is enough for the single-page providers; for OCW every page that
 * answers is concatenated under a heading naming where it came from, so a
 * module's grounding can be traced to a page.
 *
 * A candidate none of whose pages answer is thrown, not returned empty. The
 * outline step cannot ground anything in zero characters, and returning a
 * material with `contentChars: 0` would let it silently invent a course; the
 * caller loops over candidates and moves to the next one.
 */
export async function fetchCurriculumMaterial(
  candidate: CurriculumCandidate,
  deps: FetchDeps,
): Promise<CurriculumMaterial> {
  const sections: string[] = []
  for (const { label, url } of materialPages(candidate)) {
    let page: Awaited<ReturnType<SourceFetch>>
    try {
      page = await deps.fetchMarkdown(url)
    } catch {
      continue
    }
    if (!page.ok || page.body.trim().length === 0) continue
    sections.push(`## ${label}\n\nSource: ${url}\n\n${page.body.trim()}`)
    if (!READS_EVERY_PAGE.has(candidate.provider)) break
  }
  if (sections.length === 0) {
    throw new Error(`curriculum material unavailable for ${candidate.sourceId}: no outline page answered`)
  }
  // Cap at CURRICULUM_MATERIAL_MAX_CHARS, trimming from the end (see the
  // constant for why the end is the safe side to lose).
  const markdown = sections.join('\n\n').slice(0, CURRICULUM_MATERIAL_MAX_CHARS)
  return {
    source: {
      sourceId: candidate.sourceId,
      provider: candidate.provider,
      title: candidate.title,
      url: candidate.url,
      licence: candidate.licence,
      attribution: candidate.attribution,
      retrievedAt: new Date().toISOString(),
      contentChars: markdown.length,
    },
    markdown,
  }
}

/** Providers whose outline is split across pages; the others stop at the
 * first page that answers. */
const READS_EVERY_PAGE: ReadonlySet<CurriculumProvider> = new Set(['mit-ocw'])

const materialPages = (candidate: CurriculumCandidate): ReadonlyArray<{ label: string; url: string }> => {
  switch (candidate.provider) {
    case 'mit-ocw': {
      const base = candidate.url.replace(/\/?$/, '/')
      return [
        { label: 'Calendar', url: candidate.syllabusUrl ?? `${base}pages/calendar/` },
        { label: 'Syllabus', url: `${base}pages/syllabus/` },
        { label: 'Course', url: candidate.url },
      ]
    }
    case 'ossu':
      return [{ label: 'Curriculum', url: candidate.syllabusUrl ?? OSSU_README }]
    default:
      return [
        ...(candidate.syllabusUrl && candidate.syllabusUrl !== candidate.url
          ? [{ label: 'Outline', url: candidate.syllabusUrl }]
          : []),
        { label: 'Landing page', url: candidate.url },
      ]
  }
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/** How much of the course structure a provider can hand the outline step.
 * Lower is better. Session-level (MIT calendar) beats chapter-level (an
 * OpenStax table of contents) beats a bare title with a link to read. */
const OUTLINE_DEPTH: Readonly<Record<CurriculumProvider, number>> = {
  'mit-ocw': 0,
  openstax: 1,
  ossu: 1,
  saylor: 2,
  'open-textbook-library': 3,
}

/** Licence permissiveness, lower is better. "CC0 metadata" ranks last on
 * purpose: it describes the catalogue, not the book, so the book's licence is
 * unknown until someone opens it. */
const licenceRank = (licence: string): number => {
  const l = licence.toLowerCase()
  if (/metadata/.test(l)) return 5
  if (/cc0|public domain/.test(l)) return 0
  if (/\bmit\b/.test(l)) return 1
  if (/nc/.test(l)) return 4
  if (/sa/.test(l)) return 3
  if (/cc[ -]?by/.test(l)) return 2
  return 5
}

const rankCandidates = (candidates: CurriculumCandidate[], plan: CurriculumObjectivePlan): CurriculumCandidate[] => {
  // Rank against the same list that was SEARCHED, so a candidate found only by
  // the domain backstop is scored on the query that found it rather than on a
  // list it never matched.
  const queries = planQueries(plan)
  return candidates
    .map((candidate) => ({ candidate, match: matchStrength(candidate.title, queries) }))
    .sort((a, b) =>
      OUTLINE_DEPTH[a.candidate.provider] - OUTLINE_DEPTH[b.candidate.provider]
      || licenceRank(a.candidate.licence) - licenceRank(b.candidate.licence)
      || b.match - a.match
      || titleNoise(a.candidate.title, queries) - titleNoise(b.candidate.title, queries)
      || a.candidate.title.localeCompare(b.candidate.title))
    .map(({ candidate }) => candidate)
}

/**
 * How much of a title is NOT the thing asked for.
 *
 * `matchStrength` saturates: "introduction" is a stop word, so both "Algorithms
 * for Inference" and "Introduction to Algorithms" score a perfect 1.0 against
 * "introduction to algorithms", and the ranker used to fall through to
 * alphabetical order — which handed an algorithms objective a graduate
 * inference course because A sorts before I. Counting the leftover tokens
 * breaks that tie on meaning instead of spelling: a title that is ABOUT the
 * subject carries no extra words, while one that merely mentions it does.
 */
const titleNoise = (title: string, queries: readonly string[]): number => {
  const wanted = new Set(queries.flatMap((query) => tokens(query)))
  return tokens(title).filter((token) => !wanted.has(token)).length
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'and', 'for', 'on', 'with', 'introduction', 'intro', 'course'])

const tokens = (text: string): string[] =>
  text.toLowerCase().normalize('NFKD').split(/[^a-z0-9+#]+/).filter((t) => t.length > 1 && !STOP_WORDS.has(t))

/**
 * Fraction of a query's tokens that appear in the title, taken over the best
 * query. Queries come "most specific first", so an earlier query counts a
 * little more than a later one: matching the learner's own phrasing is worth
 * more than matching the broad fallback the interpreter added.
 */
const matchStrength = (title: string, queries: readonly string[]): number => {
  const titleTokens = new Set(tokens(title))
  return queries.reduce((best, query, index) => {
    const qt = tokens(query)
    if (qt.length === 0) return best
    const hit = qt.filter((t) => titleTokens.has(t)).length / qt.length
    const weight = 1 - index * 0.05
    return Math.max(best, hit * weight)
  }, 0)
}

const dedupeBySourceId = (candidates: CurriculumCandidate[]): CurriculumCandidate[] => {
  const seen = new Set<string>()
  return candidates.filter((c) => (seen.has(c.sourceId) ? false : (seen.add(c.sourceId), true)))
}

// ---------------------------------------------------------------------------
// Provider searchers
// ---------------------------------------------------------------------------

type ProviderSearcher = (plan: CurriculumObjectivePlan, deps: SearchDeps, limit: number) => Promise<CurriculumCandidate[]>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Fetch and parse JSON, returning null on any failure so a searcher reads
 * as a straight line and the isolation lives in one place. */
const readJson = async (fetchJson: SourceFetch, url: string): Promise<unknown> => {
  const res = await fetchJson(url)
  if (!res.ok) return null
  try {
    return JSON.parse(res.body) as unknown
  } catch {
    return null
  }
}

const candidateOf = (
  provider: CurriculumProvider,
  fields: { sourceId: string; title: string; url: string; syllabusUrl?: string | null; summary?: string; matchReason: string; licence?: string },
): CurriculumCandidate => ({
  sourceId: fields.sourceId,
  provider,
  title: fields.title,
  url: fields.url,
  licence: fields.licence ?? CURRICULUM_PROVIDERS[provider].licence,
  attribution: CURRICULUM_PROVIDERS[provider].attribution,
  syllabusUrl: fields.syllabusUrl ?? null,
  summary: fields.summary ?? '',
  matchReason: fields.matchReason,
})

/**
 * The queries actually put to a provider: the plan's own, plus the domain
 * spelled as words when the plan did not already ask for it.
 *
 * The backstop is not redundancy. A planner asked for "most specific first"
 * writes phrases like "computing systems engineering", and MIT's search
 * matches every term against title AND description, so an over-specific query
 * returns either nothing or a global-health seminar whose description happens
 * to contain "systems" and "engineering". Measured 2026-09-09: a whole-of-CS
 * objective produced eight candidates, of which zero were computer science,
 * while the bare phrase "computer science" returns 101 and leads with
 * Mathematics for Computer Science. The domain is the one query we can be sure
 * reads like a course catalogue's own subject heading, because that is what a
 * domain slug is.
 */
export const planQueries = (plan: CurriculumObjectivePlan): string[] => {
  const domainQuery = plan.domain.replace(/[-_]+/g, ' ').trim()
  const asked = new Set(plan.queries.map((query) => query.toLowerCase().trim()))
  // Appended, not prepended: the ranker weights earlier queries higher on the
  // rule that the learner's own phrasing beats a broad fallback, and the
  // domain IS the broad fallback. It changes what is FOUND, not what wins.
  return domainQuery && !asked.has(domainQuery.toLowerCase()) ? [...plan.queries, domainQuery] : [...plan.queries]
}

/** MIT's discovery API is the one provider with real search, so every query
 * is put to it; results are keyed by course slug so the same course found by
 * two queries is one candidate. The calendar page is set as the syllabus URL
 * because it, not the syllabus, carries the session-by-session outline. */
const searchMitOcw: ProviderSearcher = async (plan, deps, limit) => {
  const out: CurriculumCandidate[] = []
  for (const query of planQueries(plan)) {
    const url = `${MIT_LEARN_API}?platform=ocw&resource_category=course&q=${encodeURIComponent(query)}&limit=${limit}`
    const json = await readJson(deps.fetchJson, url)
    const results = isRecord(json) && Array.isArray(json.results) ? json.results : []
    for (const item of results) {
      if (!isRecord(item)) continue
      const courseUrl = str(item.url)
      const slug = ocwSlug(courseUrl)
      const title = str(item.title)
      if (!slug || !title) continue
      const base = `${MIT_OCW_COURSES}${slug}/`
      out.push(candidateOf('mit-ocw', {
        sourceId: `mit-ocw:${slug}`,
        title,
        url: base,
        syllabusUrl: `${base}pages/calendar/`,
        summary: str(item.description),
        matchReason: `MIT Learn search for "${query}"`,
      }))
    }
  }
  return newestEditionPerCourse(out)
}

/**
 * OCW publishes the same course many times, once per term. A search for
 * algorithms returns 6-006 for spring 2020, fall 2011 and spring 2008, and
 * reading all three spends every material slot on one syllabus in three
 * vintages. Collapsing by course NUMBER and keeping the newest term leaves the
 * slots for genuinely different courses. Different numbers are different
 * courses and are all kept: 6-006 and 6-046j teach different things.
 */
export const newestEditionPerCourse = (candidates: readonly CurriculumCandidate[]): CurriculumCandidate[] => {
  const best = new Map<string, { candidate: CurriculumCandidate; year: number }>()
  const order: string[] = []
  for (const candidate of candidates) {
    const slug = candidate.sourceId.replace(/^mit-ocw:/, '')
    // `6-006-introduction-to-algorithms-spring-2020` -> number `6-006`, year 2020.
    const number = /^([0-9]+[a-z]*(?:-[0-9]+[a-z]*)?)-/.exec(slug)?.[1] ?? slug
    const year = Number(/-((?:19|20)[0-9]{2})$/.exec(slug)?.[1] ?? 0)
    const held = best.get(number)
    if (!held) { best.set(number, { candidate, year }); order.push(number); continue }
    if (year > held.year) best.set(number, { candidate, year })
  }
  return order.map((number) => best.get(number)!.candidate)
}

const ocwSlug = (url: string): string | null => {
  const m = /ocw\.mit\.edu\/courses\/([^/?#]+)/.exec(url)
  return m?.[1] ?? null
}

/** OpenStax has no search endpoint; the whole catalogue is one JSON page, so
 * we filter titles locally. The Wagtail slug in `meta.slug` is the detail
 * page slug (`college-algebra-2e`), which is why it is preferred over
 * slugifying the title. */
const searchOpenstax: ProviderSearcher = async (plan, deps) => {
  const json = await readJson(deps.fetchJson, OPENSTAX_BOOKS_API)
  const items = isRecord(json) && Array.isArray(json.items) ? json.items : []
  const out: CurriculumCandidate[] = []
  for (const item of items) {
    if (!isRecord(item)) continue
    const title = str(item.title)
    const match = matchStrength(title, plan.queries)
    if (!title || match === 0) continue
    const meta = isRecord(item.meta) ? item.meta : {}
    const slug = str(meta.slug) || slugifyTitle(title)
    const url = `${OPENSTAX_BOOK_PAGE}${slug}`
    const licenceName = str(item.license_name)
    const licence = licenceName ? `${licenceName} ${str(item.license_version)}`.trim() : undefined
    out.push(candidateOf('openstax', {
      sourceId: `openstax:${slug}`,
      title,
      url,
      syllabusUrl: url,
      matchReason: `title matched ${(match * 100).toFixed(0)}% of a plan query`,
      ...(licence ? { licence } : {}),
    }))
  }
  return out
}

const slugifyTitle = (title: string): string =>
  title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/** Saylor's course pages refuse guests, so the GitHub bulk-export listing is
 * the catalogue. Entries are named by course code plus title
 * (`BUS101-Introduction-to-Business`), so a token match against the name is
 * the search. `html_url` is whatever GitHub gives for the entry (a blob for a
 * file, a tree for a directory) and is used as-is for the outline read. */
const searchSaylor: ProviderSearcher = async (plan, deps) => {
  const json = await readJson(deps.fetchJson, SAYLOR_BACKUPS_API)
  const entries = Array.isArray(json) ? json : []
  const out: CurriculumCandidate[] = []
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const name = str(entry.name)
    const match = matchStrength(name.replace(/[-_.]+/g, ' '), plan.queries)
    if (!name || match === 0) continue
    const htmlUrl = str(entry.html_url) || `${SAYLOR_BACKUPS_REPO}/blob/master/${encodeURIComponent(name)}`
    out.push(candidateOf('saylor', {
      sourceId: `saylor:${name}`,
      title: name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' '),
      url: htmlUrl,
      syllabusUrl: htmlUrl,
      matchReason: `export filename matched ${(match * 100).toFixed(0)}% of a plan query`,
    }))
  }
  return out
}

const COMPUTING_WORDS = /\b(computer|computing|software|programming|algorithms?|data structures?|operating systems?|compilers?|databases?|machine learning|networks?|cs)\b/i

/** OSSU is a single README covering all of computer science, so it is one
 * candidate and it is offered only for computing objectives. No fetch happens
 * at search time: the file's existence is not in question and its content is
 * only useful once the outline step reads it. */
const searchOssu: ProviderSearcher = async (plan) => {
  const computing = COMPUTING_WORDS.test(plan.domain) || plan.queries.some((q) => COMPUTING_WORDS.test(q))
  if (!computing) return []
  return [candidateOf('ossu', {
    sourceId: 'ossu:computer-science',
    title: 'OSSU Computer Science',
    url: OSSU_REPO,
    syllabusUrl: OSSU_README,
    summary: 'A complete computer science curriculum assembled from free online courses, with explicit prerequisites per course.',
    matchReason: 'domain is computing',
  })]
}

/** The Open Textbook Library catalogue is paged; page one is enough for
 * discovery because this provider ranks last regardless and the outline
 * step never grounds a module in it alone. The shape is read leniently
 * (`data`, `textbooks` or a bare array) because the endpoint is an
 * undocumented export rather than a versioned API. */
const searchOpenTextbookLibrary: ProviderSearcher = async (plan, deps) => {
  const json = await readJson(deps.fetchJson, OTL_CATALOGUE)
  const list = Array.isArray(json)
    ? json
    : isRecord(json) && Array.isArray(json.data)
      ? json.data
      : isRecord(json) && Array.isArray(json.textbooks)
        ? json.textbooks
        : []
  const out: CurriculumCandidate[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const title = str(item.title)
    const match = matchStrength(title, plan.queries)
    const id = typeof item.id === 'number' || typeof item.id === 'string' ? String(item.id) : ''
    if (!title || !id || match === 0) continue
    const url = str(item.url) || `${OTL_BOOK_PAGE}${id}`
    out.push(candidateOf('open-textbook-library', {
      sourceId: `open-textbook-library:${id}`,
      title,
      url,
      syllabusUrl: null,
      summary: str(item.description),
      matchReason: `catalogue title matched ${(match * 100).toFixed(0)}% of a plan query`,
    }))
  }
  return out
}

const PROVIDER_SEARCHERS: Readonly<Record<CurriculumProvider, ProviderSearcher>> = {
  'mit-ocw': searchMitOcw,
  openstax: searchOpenstax,
  saylor: searchSaylor,
  ossu: searchOssu,
  'open-textbook-library': searchOpenTextbookLibrary,
}

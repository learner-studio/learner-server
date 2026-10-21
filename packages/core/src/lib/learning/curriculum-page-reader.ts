/** Which crawl stack serves page reads (the previous host's two-state crawler switch). */
export type CrawlerInfrastructureMode = 'cloudflare' | 'local'
import type { SourceFetch } from './curriculum-sources.js'

/**
 * How a curriculum run reads a published page.
 *
 * This exists as its own function for one reason: the standing crawler rule
 * says `local` mode means ZERO Cloudflare calls, not "Cloudflare with a
 * fallback", and a new code path that can reach Cloudflare while the mode is
 * `local` is a bug however well it performs. Sourcing course material is
 * exactly such a new path, so the gate is written here, once, where a test can
 * prove it rather than in a step body where it would read as a detail.
 *
 * The JSON side is deliberately NOT gated. MIT's learning-resources API,
 * OpenStax's CMS API and the GitHub contents API are APIs we are entitled to
 * call directly; routing a JSON GET through a browser-rendering provider would
 * cost money and return the same bytes.
 */

export type CurriculumReaderDeps = {
  readonly mode: CrawlerInfrastructureMode
  /** Cloudflare Browser Rendering `/markdown`. Never called in local mode. */
  readonly renderCloudflareMarkdown: (url: string) => Promise<string>
  /** The internal stack: Firecrawl, escalating to Camoufox. */
  readonly renderLocalMarkdown: (url: string) => Promise<string>
}

export function createCurriculumPageReader(deps: CurriculumReaderDeps): SourceFetch {
  const render = deps.mode === 'local' ? deps.renderLocalMarkdown : deps.renderCloudflareMarkdown
  return async (url: string) => {
    try {
      const body = await render(url)
      // A provider that answers with nothing is not a success. The outline step
      // cannot ground a curriculum in zero characters, and reporting ok here
      // would let it invent a course from a blank page.
      return { ok: body.trim().length > 0, status: body.trim().length > 0 ? 200 : 204, body }
    } catch {
      return { ok: false, status: 0, body: '' }
    }
  }
}

/**
 * The minimum a JSON reader needs from `fetch`. Declared rather than borrowed
 * from `typeof fetch` so a test can hand it a two-line stub instead of a full
 * Fetch API implementation.
 */
export type JsonGet = (url: string, init: { headers: Record<string, string> }) => Promise<{
  readonly ok: boolean
  readonly status: number
  text: () => Promise<string>
}>

/** A plain JSON GET, for provider APIs. Never routed through a renderer. */
export function createCurriculumJsonReader(fetchImpl: JsonGet = fetch): SourceFetch {
  return async (url: string) => {
    try {
      const response = await fetchImpl(url, { headers: { accept: 'application/json' } })
      return { ok: response.ok, status: response.status, body: await response.text() }
    } catch {
      return { ok: false, status: 0, body: '' }
    }
  }
}

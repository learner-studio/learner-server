/**
 * Reads one page as markdown through the local self-hosted Firecrawl
 * (`POST /v1/scrape`). Curriculum generation is the only consumer: it needs a
 * page's text, never a crawl. Learner has no crawler stack of its own.
 */
export interface MarkdownReader { markdown(url: string): Promise<string> }

export class FirecrawlMarkdownReader implements MarkdownReader {
  constructor(private readonly baseUrl: string, private readonly timeoutMs = 120_000) {}
  async markdown(url: string): Promise<string> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/v1/scrape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) throw new Error(`Firecrawl scrape failed: HTTP ${response.status}`)
    const body = await response.json() as { success?: boolean; data?: { markdown?: unknown } }
    return typeof body.data?.markdown === 'string' ? body.data.markdown : ''
  }
}

// A real HTTP server around the server's own spool code (the functions
// uploadTranscript / getTranscriptUploadState call), so the uploader's heal
// paths run against the true offset/409 rules. Faults are injected per test.
import { appendUploadedTranscript, transcriptUploadState, UploadTranscriptInput, GetTranscriptUploadStateInput } from '@learner/core/lib/learning/transcript-uploads.js'

export interface Fault { only?: string; status?: number; afterApply?: boolean; delayMs?: number; down?: boolean }
export function spoolServer(root: string) {
  const fault: Fault = {}
  const calls: { name: string; offset?: number; path?: string }[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const name = new URL(request.url).pathname.split('/rpc/')[1] ?? ''
      if (fault.down) return new Response('{"message":"down"}', { status: 502 })
      if (fault.delayMs) await Bun.sleep(fault.delayMs)
      const { data } = await request.json() as { data: Record<string, unknown> }
      calls.push({ name, offset: data.offset as number | undefined, path: data.path as string | undefined })
      const faulty = fault.status && (!fault.only || fault.only === name)
      if (faulty && !fault.afterApply) return Response.json({ message: 'injected' }, { status: fault.status })
      try {
        const body = name === 'uploadTranscript' ? await appendUploadedTranscript(root, UploadTranscriptInput.parse(data))
          : name === 'getTranscriptUploadState' ? await transcriptUploadState(root, GetTranscriptUploadStateInput.parse(data))
          : null
        if (!body) return Response.json({ message: 'not found' }, { status: 404 })
        // The write happened; the answer is lost.
        if (faulty && fault.afterApply) return Response.json({ message: 'injected after apply' }, { status: fault.status })
        return Response.json(body)
      } catch (error) {
        const status = (error as { statusCode?: number; status?: number }).statusCode ?? (error as { status?: number }).status ?? 500
        return Response.json({ message: (error as Error).message }, { status })
      }
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, fault, calls, stop: () => server.stop(true) }
}

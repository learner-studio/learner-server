import { createHash } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { DB } from '../types/db.types.js'
import { LearningExposureObservation, QueryLearningExposureInput, QueryLearningExposureOutput, QueryLearningExposureExchangesOutput, type ExposureObservation } from '../lib/learning/learning-exposure-schemas.js'

export const exposureIsVisible = (value: ExposureObservation): boolean => {
  if (!value.logicalMessageKey) return false
  // Model-context echoes and transport retries are never fresh human input.
  if (value.direction === 'user_to_model') return value.authorship === 'human' && value.stage === 'received'
  return value.direction === 'model_to_user' && value.authorship === 'agent'
    && ((value.stage === 'delivered' && value.visibility === 'delivered')
      || (value.stage === 'user_facing' && value.visibility === 'intended'))
}

// The observations the semantic index grades: one per message, as (id,
// raw_version_id). Shared with LearningSemanticIndexService.hasPendingChanges,
// which must agree with it or every idle tick sees a change that never freezes.
export const canonicalIndexManifestQuery = sql`WITH ranked AS (
    SELECT observation_id AS id,payload,raw_version_id,observed_at,inserted_at,row_number() OVER (
      PARTITION BY COALESCE(logical_message_key,observation_id::text),direction
      ORDER BY COALESCE(payload->'correlation'->>'historyProjectionRevision'='3',false) DESC,
        COALESCE(payload->'correlation'->>'cliProjectionRevision'='2',false) DESC,
        visible DESC,observed_at DESC,inserted_at DESC,observation_id DESC) AS rank
    FROM learning_exposure_observations WHERE COALESCE(payload->'correlation'->>'proofFixture','false')<>'true'
  ), visible AS (
    -- A resumed/forked Claude session and a Codex child thread copy the parent's
    -- messages under a new thread with the same native id. The thread is the
    -- second key segment; other providers' is not a thread (discord's is an
    -- account), so they keep the full key as their identity.
    SELECT id,raw_version_id,observed_at,inserted_at,payload->>'direction' AS direction,
      CASE WHEN payload->>'logicalMessageKey' ~ '^(claude|codex):'
        THEN regexp_replace(payload->>'logicalMessageKey','^(claude|codex):[^:]+:','\\1:') ELSE payload->>'logicalMessageKey' END AS identity,
      CASE WHEN payload->>'logicalMessageKey' ~ '^(claude|codex):'
        THEN split_part(payload->>'logicalMessageKey',':',2) ELSE payload->>'logicalMessageKey' END AS thread
    FROM ranked WHERE rank=1 AND payload->>'logicalMessageKey' IS NOT NULL
    AND ((payload->>'direction'='user_to_model' AND payload->>'authorship'='human' AND payload->>'stage'='received')
      OR (payload->>'direction'='model_to_user' AND payload->>'authorship'='agent'
        AND ((payload->>'stage'='delivered' AND payload->>'visibility'='delivered')
          OR (payload->>'stage'='user_facing' AND payload->>'visibility'='intended'))))
  ), threads AS (
    -- A copy keeps the original's timestamps (Claude) or gets later ones (Codex),
    -- so the original is the thread that starts first, then was ingested first.
    -- Ranking whole threads keeps a prompt and its reply from the same thread;
    -- per-row ranking split them across threads and left both halves unpaired.
    -- Undated rows carry the 1970 fallback and must not make a thread "first".
    SELECT *,min(observed_at) FILTER (WHERE observed_at>'1970-01-01T00:00:00Z') OVER (PARTITION BY thread) AS thread_start,
      min(inserted_at) OVER (PARTITION BY thread) AS thread_inserted
    FROM visible
  ), copies AS (
    SELECT id,raw_version_id,row_number() OVER (
      PARTITION BY identity,direction ORDER BY thread_start NULLS LAST,thread_inserted,thread,id) AS copy
    FROM threads
  ) SELECT id,raw_version_id FROM copies WHERE copy=1`

const boundedObservation = (value: ExposureObservation): ExposureObservation => ({
  ...value,
  // UI/query bounds do not modify the raw archive. Callers can follow its
  // version reference rather than mistake a preview for complete message text.
  parts: value.parts.map((part) => part.text && part.text.length > 8192
    ? { ...part, text: undefined, textLength: part.text.length, textOmitted: true }
    : part),
})

export class LearningExposureService {
  readonly implementationVersion = 4
  constructor(private readonly kysely: Kysely<DB>) {}

  async ingestObservation(input: unknown, rawVersionId: string) {
    const observation = LearningExposureObservation.parse(input)
    const serialized = JSON.stringify(observation)
    const payloadHash = createHash('sha256').update(serialized).digest('hex')
    return this.kysely.transaction().execute(async (trx) => {
      const inserted = await sql<{ observationId: string }>`INSERT INTO learning_exposure_observations
        (observation_id,dedupe_key,logical_message_key,direction,visible,observed_at,raw_version_id,payload,payload_sha256)
        VALUES (${observation.observationId}::uuid,${observation.dedupeKey ?? null},${observation.logicalMessageKey},
          ${observation.direction},${exposureIsVisible(observation)},${observation.observedAt}::timestamptz,
          ${rawVersionId}::uuid,${serialized}::jsonb,${payloadHash})
        ON CONFLICT DO NOTHING RETURNING observation_id AS "observationId"`.execute(trx)
      if (inserted.rows.length) return { observationId: observation.observationId, inserted: true }
      const existing = await sql<{ observationId: string; payloadHash: string }>`SELECT observation_id AS "observationId",
        payload_sha256 AS "payloadHash" FROM learning_exposure_observations
        WHERE observation_id=${observation.observationId}::uuid
          OR (${observation.dedupeKey ?? null}::text IS NOT NULL AND dedupe_key=${observation.dedupeKey ?? null})`.execute(trx)
      // Differing hook payloads must keep separate observations, even if their
      // canonical message is shared. A producer reusing identity is a conflict.
      if (existing.rows.length !== 1 || existing.rows[0]!.payloadHash !== payloadHash) {
        throw new Error('Exposure observation identity was reused with different content')
      }
      return { observationId: existing.rows[0]!.observationId, inserted: false }
    })
  }

  /** Internal identity-only manifest for indexing: same default canonical ranking
   * as query(), without per-message media hydration or repeated page ranking. */
  async canonicalIndexManifest() {
    return (await sql<{id:string;rawVersionId:string}>`WITH manifest AS (${canonicalIndexManifestQuery})
      SELECT id,raw_version_id AS "rawVersionId" FROM manifest ORDER BY id`.execute(this.kysely)).rows
  }
  async query(input: unknown) {
    const options = QueryLearningExposureInput.parse(input)
    const rows = await sql<{ id: string; payload: unknown; rawVersionId: string; observationCount: string }>`
      WITH ranked AS (
        SELECT observation_id AS id,payload,raw_version_id,
          count(*) OVER (PARTITION BY COALESCE(logical_message_key,observation_id::text),direction) AS observation_count,
          row_number() OVER (PARTITION BY COALESCE(logical_message_key,observation_id::text),direction
            ORDER BY COALESCE(payload->'correlation'->>'historyProjectionRevision'='3',false) DESC,
              COALESCE(payload->'correlation'->>'cliProjectionRevision'='2',false) DESC,
              visible DESC,observed_at DESC,inserted_at DESC,observation_id DESC) AS rank
        FROM learning_exposure_observations
        WHERE (${options.direction ?? null}::text IS NULL OR direction=${options.direction ?? null})
          AND (${options.logicalMessageKey ?? null}::text IS NOT NULL OR COALESCE(payload->'correlation'->>'proofFixture','false')<>'true')
          AND (${options.logicalMessageKey ?? null}::text IS NULL OR logical_message_key=${options.logicalMessageKey ?? null})
      ) SELECT id,payload,raw_version_id AS "rawVersionId",observation_count AS "observationCount" FROM ranked
      WHERE rank=1 AND (${options.includeUnknown} OR (payload->>'logicalMessageKey' IS NOT NULL
        AND ((payload->>'direction'='user_to_model' AND payload->>'authorship'='human' AND payload->>'stage'='received')
          OR (payload->>'direction'='model_to_user' AND payload->>'authorship'='agent'
            AND ((payload->>'stage'='delivered' AND payload->>'visibility'='delivered')
              OR (payload->>'stage'='user_facing' AND payload->>'visibility'='intended'))))))
        AND (${options.cursor ?? null}::uuid IS NULL OR id>${options.cursor ?? null}::uuid)
        AND (${options.mediaKind ?? null}::text IS NULL OR EXISTS(
          SELECT 1 FROM learning_exposure_observations related,jsonb_array_elements(related.payload->'parts') part
          WHERE related.logical_message_key=ranked.payload->>'logicalMessageKey' AND related.direction=ranked.payload->>'direction'
            AND part->>'mediaKind'=${options.mediaKind ?? null}))
      ORDER BY id LIMIT ${options.limit + 1}`.execute(this.kysely)
    const items = []
    let bytes = 0
    let hasMore = rows.rows.length > options.limit
    for (const row of rows.rows.slice(0, options.limit)) {
      const observation = boundedObservation(LearningExposureObservation.parse(row.payload))
      const related = observation.logicalMessageKey ? await sql<{ payload: unknown }>`
        SELECT payload FROM learning_exposure_observations
        WHERE logical_message_key=${observation.logicalMessageKey} AND direction=${observation.direction}
        ORDER BY observed_at DESC,inserted_at DESC LIMIT 100`.execute(this.kysely) : { rows: [] }
      const media = new Map<string, ExposureObservation['parts'][number]>()
      for (const relatedRow of related.rows) {
        const value = LearningExposureObservation.parse(relatedRow.payload)
        for (const [key, metadata] of Object.entries(value.correlation)) {
          if (observation.correlation[key] === undefined) observation.correlation[key] = metadata
        }
        for (const part of value.parts.filter((part) => part.type === 'media')) {
          // A repaired capture supersedes a failed revision of the same slot.
          // Old failures remain raw provenance, not duplicate active media.
          const key = `${part.ordinal}:${part.role ?? ''}`
          if (!media.has(key) || (part.archiveVersionId && !media.get(key)?.archiveVersionId)) media.set(key, part)
        }
      }
      if (Number(row.observationCount) > 100) observation.gaps.push({ code: 'related-observation-query-bound', detail: 'Only the newest 100 linked observations supplied media/provenance for this page; older raw observations remain stored.' })
      const item = { id: row.id, logicalMessageKey: observation.logicalMessageKey, observation,
        rawVersionId: row.rawVersionId, observationCount: Number(row.observationCount),
        media: related.rows.length ? [...media.values()] : observation.parts.filter((part) => part.type === 'media') }
      const size = Buffer.byteLength(JSON.stringify(item))
      if (bytes + size > 512 * 1024 && items.length) { hasMore = true; break }
      if (size > 512 * 1024) throw new Error('Exposure metadata exceeds bounded query response; inspect the raw version')
      items.push(item); bytes += size
    }
    return QueryLearningExposureOutput.parse({ items,
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
      limitations: [
        'Intended display and successful channel delivery do not prove the user read or learned the content.',
        'Only explicit message identities join observations; unknown or uncorrelated input is excluded by default.',
        'Text over 8192 characters is omitted with textOmitted=true; complete bytes remain in rawVersionId.',
        'Media capture status and gaps must be checked; a URL alone is not archived media.',
      ],
    })
  }

  async imported(importKey: string) {
    const result = await sql`SELECT 1 FROM learning_exposure_imports WHERE import_key=${importKey}
      AND (status='completed' OR gap_code<>'media-archive-verification-failed')`.execute(this.kysely)
    return result.rows.length > 0
  }

  async status() {
    const counts = await sql<{ observations: string; visibleMessages: string; nonvisible: string }>`
      SELECT count(*) AS observations,
        count(DISTINCT (logical_message_key,direction)) FILTER(WHERE visible) AS "visibleMessages",
        count(*) FILTER(WHERE NOT visible) AS nonvisible FROM learning_exposure_observations`.execute(this.kysely)
    const gaps = await sql<{ code: string; count: string }>`SELECT gap_code AS code,count(*) AS count
      FROM learning_exposure_imports WHERE status='gap' GROUP BY gap_code`.execute(this.kysely)
    return { observations: Number(counts.rows[0]?.observations ?? 0), visibleMessages: Number(counts.rows[0]?.visibleMessages ?? 0),
      nonvisibleObservations: Number(counts.rows[0]?.nonvisible ?? 0),
      importGaps: gaps.rows.map((row) => ({ code: row.code, count: Number(row.count) })) }
  }

  /** Validate an explicit producer identity against every stored user input,
   * including rows that a bounded/default consumer page does not expose. */
  async explicitUserIdentityIsUnique(input: { runId: string } | { codexTurnId: string; codexThreadId: string }) {
    const [field, value] = 'runId' in input
      ? ['runId', input.runId] as const
      : ['codexTurnId', input.codexTurnId] as const
    const threadId = 'codexThreadId' in input ? input.codexThreadId : null
    const result = await sql<{ count: string }>`SELECT count(DISTINCT logical_message_key) AS count
      FROM learning_exposure_observations WHERE direction='user_to_model'
        AND logical_message_key IS NOT NULL AND payload->'correlation'->>${field}=${value}
        AND (${threadId}::text IS NULL OR payload->'correlation'->>'codexThreadId'=${threadId})`.execute(this.kysely)
    return Number(result.rows[0]?.count ?? 0) === 1
  }

  async queryExchanges(input: unknown) {
    const options = QueryLearningExposureInput.parse(input)
    const page = await this.query(input)
    if (options.logicalMessageKey && !options.direction) {
      // An exact exchange lookup must also find replies whose own message IDs
      // differ from their explicitly recorded parent input. Never scan by text.
      const replies = await sql<{ key: string }>`SELECT DISTINCT logical_message_key AS key
        FROM learning_exposure_observations WHERE direction='model_to_user' AND logical_message_key IS NOT NULL
          AND payload->'correlation'->>'parentLogicalMessageKey'=${options.logicalMessageKey}
        ORDER BY logical_message_key LIMIT 100`.execute(this.kysely)
      const seen = new Set(page.items.map((item) => item.id))
      for (const reply of replies.rows) {
        const replyPage = await this.query({ ...options, cursor: undefined, logicalMessageKey: reply.key })
        for (const item of replyPage.items) if (!seen.has(item.id)) { page.items.push(item); seen.add(item.id) }
      }
      if (replies.rows.length === 100) page.limitations.push('Explicit parent lookup is bounded to 100 reply identities.')
    }
    const parentKeys = new Set(page.items.flatMap((item) => {
      const parent = item.observation.correlation.parentLogicalMessageKey
      return item.observation.direction === 'model_to_user' && typeof parent === 'string' ? [parent] : []
    }))
    const items: Array<{
      exchangeId: string; user: { text: string | null; media: ExposureObservation['parts']; meta: Record<string, unknown> } | null;
      agent: Array<{ text: string | null; media: ExposureObservation['parts']; meta: Record<string, unknown> }>;
      linkage: 'explicit' | 'unpaired';
    }> = []
    // Count across the store, not just this page: a debounced second input may
    // be outside the requested cursor, direction, media, or message filter.
    for (const item of page.items) {
      const observation = item.observation
      if (observation.direction !== 'user_to_model' && observation.direction !== 'model_to_user') continue
      const correlation = observation.correlation
      // A shared session alone does NOT identify an exchange. Never pair by
      // proximity, text equality, or the latest active run in the session.
      const explicitRun = typeof correlation.runId === 'string'
        && await this.explicitUserIdentityIsUnique({ runId: correlation.runId }) ? correlation.runId : null
      const explicitTurn = typeof correlation.codexTurnId === 'string' && typeof correlation.codexThreadId === 'string'
        && await this.explicitUserIdentityIsUnique({ codexTurnId: correlation.codexTurnId, codexThreadId: correlation.codexThreadId })
        ? `${correlation.codexThreadId}:${correlation.codexTurnId}` : null
      const explicitParent = observation.direction === 'model_to_user' && typeof correlation.parentLogicalMessageKey === 'string'
        ? correlation.parentLogicalMessageKey : item.logicalMessageKey && parentKeys.has(item.logicalMessageKey) ? item.logicalMessageKey : null
      const key = explicitParent ? `parent-message:${explicitParent}` : explicitRun ? `openclaw-run:${explicitRun}` : explicitTurn ? `codex-turn:${explicitTurn}` : item.logicalMessageKey ?? item.id
      const message = {
        text: observation.parts.some((part) => part.textOmitted) ? null
          : observation.parts.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n'),
        media: item.media,
        meta: { ...correlation, observationId: observation.observationId, logicalMessageKey: item.logicalMessageKey,
          observedAt: observation.observedAt, authorship: observation.authorship, visibility: observation.visibility,
          rawVersionId: item.rawVersionId, observationCount: item.observationCount, gaps: observation.gaps,
          direction: observation.direction,
          textOmitted: observation.parts.some((part) => part.textOmitted), readByUser: 'unknown' },
      }
      let exchange = items.find((candidate) => candidate.exchangeId === key)
      // More than one real input in one run (e.g. debounce) stays distinct.
      if (!exchange || (observation.direction === 'user_to_model' && exchange.user)) {
        exchange = { exchangeId: exchange ? `${key}:${item.id}` : key, user: null, agent: [], linkage: explicitParent || explicitRun || explicitTurn ? 'explicit' : 'unpaired' }
        items.push(exchange)
      }
      if (observation.direction === 'user_to_model') exchange.user = message
      else if (observation.direction === 'model_to_user') exchange.agent.push(message)
    }
    for (const item of items) item.agent.sort((a, b) => String(a.meta.observedAt).localeCompare(String(b.meta.observedAt)))
    return QueryLearningExposureExchangesOutput.parse({ items, nextCursor: page.nextCursor,
      limitations: [...page.limitations, 'Only explicit run/turn identities pair the two sides; null user or empty agent means no proven partner on this page.'],
    })
  }

  async markImported(importKey: string, rawVersionId: string | null, gapCode: string | null = null) {
    await sql`INSERT INTO learning_exposure_imports(import_key,raw_version_id,status,gap_code)
      VALUES(${importKey},${rawVersionId}::uuid,${gapCode ? 'gap' : 'completed'},${gapCode})
      ON CONFLICT(import_key) DO UPDATE SET raw_version_id=EXCLUDED.raw_version_id,status=EXCLUDED.status,
        gap_code=EXCLUDED.gap_code,updated_at=NOW()`.execute(this.kysely)
  }
}

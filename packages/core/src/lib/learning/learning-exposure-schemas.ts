import { z } from "zod";

// A transport observation is not a second user message. Only explicit native
// identities may join observations; content hashes identify bytes, not people
// or turns. Visibility is exposure evidence, never proof of reading/mastery.
export const LearningExposurePart = z.object({
  ordinal: z.number().int().nonnegative(),
  type: z.enum(["text", "media"]),
  role: z
    .enum(["staged", "original", "model-input", "model-output", "delivery"])
    .optional(),
  deliveryEvidence: z
    .enum(["confirmed", "prepared-only", "unknown"])
    .optional(),
  text: z.string().optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  textLength: z.number().int().nonnegative().optional(),
  textOmitted: z.boolean().optional(),
  byteLength: z.number().int().nonnegative().optional(),
  mimeType: z.string().optional(),
  mediaKind: z.string().optional(),
  spoolRelativePath: z.string().optional(),
  /** JSON pointer to embedded bytes inside the immutable raw source version. */
  embeddedLocator: z.string().startsWith("/").optional(),
  archiveVersionId: z.string().uuid().optional(),
  captureStatus: z.enum([
    "captured",
    "embedded",
    "remote-pending",
    "missing",
    "refused",
  ]),
  gapCode: z.string().optional(),
});
export const LearningExposureObservation = z.object({
  schemaVersion: z.literal(1),
  observationId: z.string().uuid(),
  dedupeKey: z.string().nullable().optional(),
  hook: z.string(),
  observedAt: z.string().datetime(),
  logicalMessageKey: z.string().nullable(),
  direction: z.enum(["user_to_model", "model_to_user", "internal", "unknown"]),
  stage: z.enum([
    "received",
    "model_input",
    "model_output",
    "finalizing",
    "delivery_attempt",
    "delivered",
    "failed",
    "gap",
    "user_facing",
  ]),
  authorship: z
    .enum(["human", "agent", "system", "unknown"])
    .default("unknown"),
  visibility: z
    .enum(["intended", "delivered", "internal", "unknown"])
    .default("unknown"),
  correlation: z.record(z.string(), z.unknown()),
  parts: z.array(LearningExposurePart),
  gaps: z.array(z.object({ code: z.string(), detail: z.string() })),
});
export type ExposureObservation = z.infer<typeof LearningExposureObservation>;
export const QueryLearningExposureInput = z.object({
  limit: z.number().int().min(1).max(100).default(30),
  cursor: z.string().uuid().optional(),
  direction: z.enum(["user_to_model", "model_to_user"]).optional(),
  mediaKind: z.string().max(64).optional(),
  includeUnknown: z.boolean().default(false),
  logicalMessageKey: z.string().max(2048).optional(),
});
export const QueryLearningExposureOutput = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      logicalMessageKey: z.string().nullable(),
      observation: LearningExposureObservation,
      rawVersionId: z.string().uuid(),
      observationCount: z.number().int().positive(),
      media: z.array(LearningExposurePart),
    }),
  ),
  nextCursor: z.string().uuid().nullable(),
  limitations: z.array(z.string()),
});
export const LearningExposureIngestOutput = z.object({
  processed: z.number().int(),
  pending: z.number().int(),
  gaps: z.number().int(),
});
export const LearningExposureConsolidatedMessage = z.object({
  text: z.string().nullable(),
  media: z.array(LearningExposurePart),
  meta: z.record(z.string(), z.unknown()),
});
export const QueryLearningExposureExchangesOutput = z.object({
  items: z.array(
    z.object({
      exchangeId: z.string(),
      user: LearningExposureConsolidatedMessage.nullable(),
      agent: z.array(LearningExposureConsolidatedMessage),
      linkage: z.enum(["explicit", "unpaired"]),
    }),
  ),
  nextCursor: z.string().uuid().nullable(),
  limitations: z.array(z.string()),
});

import { defineFunction } from '../../runtime/define.js'
import { z } from 'zod'

import {
  MODEL_CATALOG,
  listCapabilityModels,
  capabilityModelSchema,
  modelCapabilitySchema,
  MODEL_CATALOG_PROBED_AT,
  cliEffortSchema,
  llmBackendSchema,
  modelProbeStatusSchema,
} from '@learner/llm/lib/llm/model-catalog.js'

export const ListModelCatalogInput = z.object({capability:modelCapabilitySchema.optional()}).optional()

/**
 * The wire shape deliberately mirrors the catalogue rather than flattening it:
 * a selector needs to know which efforts belong to WHICH model, because the
 * effort set is per-model (gemini-3.1-pro has no medium, only Sol and Terra
 * have ultra). A flat list of models plus a flat list of efforts would let the
 * UI offer a pairing the backend cannot run.
 */
export const ListModelCatalogOutput = z.object({
  probedAt: z.string(),
  capabilityModels: z.array(capabilityModelSchema),
  models: z.array(
    z.object({
      backend: llmBackendSchema,
      id: z.string(),
      label: z.string(),
      notes: z.string().nullable(),
      defaultEffort: cliEffortSchema,
      /** True when the last probe found no usable effort at all. */
      unavailable: z.boolean(),
      efforts: z.array(
        z.object({
          effort: cliEffortSchema,
          status: modelProbeStatusSchema,
          reason: z.string().nullable(),
          /** False only for a combination the last probe saw fail. */
          selectable: z.boolean(),
        }),
      ),
    }),
  ),
})

export const listModelCatalog = defineFunction({
  title: 'List LLM Model Catalogue',
  description:
    'Shared model discovery: capabilityModels includes typed decision providers; models remains the CLI text-only selector view. Each entry records probe provenance.',
  expose: true,
  input: ListModelCatalogInput,
  output: ListModelCatalogOutput,
  func: async (_services, data) => ({
    capabilityModels: listCapabilityModels(data?.capability),
    probedAt: MODEL_CATALOG_PROBED_AT,
    models: MODEL_CATALOG.map((entry) => {
      const efforts = entry.efforts.map((effort) => ({
        effort: effort.effort,
        status: effort.status,
        reason: effort.reason,
        selectable: effort.status !== 'fails',
      }))
      return {
        backend: entry.backend,
        id: entry.id,
        label: entry.label,
        notes: entry.notes,
        defaultEffort: entry.defaultEffort,
        unavailable: efforts.every((e) => !e.selectable),
        efforts,
      }
    }),
  }),
})

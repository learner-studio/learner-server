import { createHash } from 'node:crypto'
import { COMPUTER_SCIENCE } from '../../functions/learning/computer-science-seed.js'

/** A concept catalog the live turn path teaches and validates against, with its version. */
export type LiveCatalog = { readonly concepts: ReadonlyArray<{ id: string; title: string }>; readonly version: string }

/** The version of a catalog: its concepts and edges, so a changed prerequisite also re-initializes turns. */
export const liveCatalogVersion = (concepts: ReadonlyArray<{ id: string; title: string }>, edges: unknown) =>
  createHash('sha256').update(JSON.stringify({ catalog: concepts, edges })).digest('hex')

/** A curriculum graph as a live catalog. The live catalog below is this applied to the shipped seed. */
export const liveCatalogOf = (graph: { concepts: ReadonlyArray<{ id: string; title: string }>; edges: unknown }): LiveCatalog => {
  const concepts = graph.concepts.map(({ id, title }) => ({ id, title }))
  return { concepts, version: liveCatalogVersion(concepts, graph.edges) }
}

// Same authoritative source for server validation and native CLI catalog delivery.
export const LIVE_CATALOG = COMPUTER_SCIENCE.concepts.map(({ id, title }) => ({ id, title }))
export const LIVE_CATALOG_VERSION = liveCatalogVersion(LIVE_CATALOG, COMPUTER_SCIENCE.edges)
/** The shipped catalog every RPC uses. Another catalog is passed explicitly (the simulated-learner experiment). */
export const LIVE: LiveCatalog = { concepts: LIVE_CATALOG, version: LIVE_CATALOG_VERSION }

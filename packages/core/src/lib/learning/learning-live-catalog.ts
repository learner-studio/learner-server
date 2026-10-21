import { createHash } from 'node:crypto'
import { COMPUTER_SCIENCE } from '../../functions/learning/computer-science-seed.js'

// Same authoritative source for Pikku validation and native CLI catalog delivery.
export const LIVE_CATALOG = COMPUTER_SCIENCE.concepts.map(({ id, title }) => ({ id, title }))
export const LIVE_CATALOG_VERSION = createHash('sha256').update(JSON.stringify({ catalog: LIVE_CATALOG, edges: COMPUTER_SCIENCE.edges })).digest('hex')

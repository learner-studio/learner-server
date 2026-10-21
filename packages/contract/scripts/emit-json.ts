import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { RPC } from '../src/rpc.js'

/** Writes contract.json: JSON Schema for every RPC, for non-TypeScript clients. */
const out = Object.fromEntries(Object.entries(RPC).map(([name, { input, output, client }]) => [name, {
  client, input: z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' }), output: z.toJSONSchema(output, { unrepresentable: 'any' }),
}]))
writeFileSync(join(import.meta.dir, '..', 'contract.json'), JSON.stringify({ rpc: out }, null, 2) + '\n')
console.log(`contract.json: ${Object.keys(out).length} RPCs`)

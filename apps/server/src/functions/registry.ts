import { isFunctionDefinition, type FunctionDefinition } from '../runtime/define.js'
import { functionModules } from './registry.gen.js'

/**
 * Every function by RPC name. The RPC name is the EXPORT name, which keeps the
 * names the hook client, the web app and stored workflow steps already use.
 * Two different definitions exported under one name is a startup error rather
 * than a silent last-one-wins.
 */
export function buildRegistry(modules = functionModules): Map<string, FunctionDefinition> {
  const registry = new Map<string, FunctionDefinition>()
  const origin = new Map<string, string>()
  for (const [file, module] of modules) {
    for (const [name, value] of Object.entries(module)) {
      if (!isFunctionDefinition(value)) continue
      const existing = registry.get(name)
      if (existing && existing !== value) throw new Error(`Duplicate function name '${name}' in ${file} and ${origin.get(name)}`)
      registry.set(name, value)
      origin.set(name, file)
    }
  }
  return registry
}

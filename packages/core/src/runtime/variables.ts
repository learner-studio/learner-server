/**
 * Operator variables from the process environment. Values are JSON-decoded
 * when they parse ('true' -> true, '3' -> 3) and returned raw otherwise: the
 * decoding the Learning code was written against.
 */
export class LocalVariablesService {
  constructor(private readonly variables: Record<string, string | undefined> = process.env) {}
  get<T = unknown>(name: string): T | undefined {
    const raw = this.variables[name]
    if (raw === undefined) return undefined
    try { return JSON.parse(raw) as T } catch { return raw as T }
  }
}

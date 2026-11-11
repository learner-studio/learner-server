import { expect, test } from 'bun:test'
import { join } from 'node:path'
import ts from 'typescript'

// Review B1: a paid step whose CLI wrapper died (a control-group stop, OOM) throws `lost` from driveAttempt so the
// step's RETRY re-runs it (free) under the lease's takeover budget. With `retries: 0` that throw fails the workflow
// instead. Every workflow wiring of a paid step must retry.
// The paid steps are DERIVED, so a new one cannot be left out: the type checker's call graph, walked back from
// `driveAttempt` through module-level functions, class methods and `rpc.invoke('<step>')`. Starting a workflow or
// enqueueing a job is not a paid call (the run's own steps are checked where they are wired).
const program = (() => {
  const config = ts.getParsedCommandLineOfConfigFile(join(import.meta.dir, '..', 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!
  return ts.createProgram(config.fileNames, config.options)
})()

function paidNames(): Set<string> {
  const checker = program.getTypeChecker()
  const callers = new Map<ts.Node, Set<ts.Node>>()
  const byName = new Map<string, ts.Node>()
  const invoked: [string, ts.Node][] = []
  const call = (callee: ts.Node, from: ts.Node) => callers.set(callee, (callers.get(callee) ?? new Set()).add(from))
  const owner = (n: ts.Node) => ts.isFunctionDeclaration(n) || (ts.isMethodDeclaration(n) && ts.isClassLike(n.parent))
    || (ts.isVariableDeclaration(n) && !!n.initializer && (ts.isSourceFile(n.parent.parent.parent) || ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)))
  const ours = program.getSourceFiles().filter((f) => !f.isDeclarationFile && !/node_modules|\.test\.tsx?$|\/tests\/|\/testing\/|\/generated\//.test(f.fileName))
  for (const file of ours) {
    const visit = (n: ts.Node, from: ts.Node | undefined): void => {
      if (owner(n)) { from = n; if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) byName.set(n.name.text, n) }
      if (from && (ts.isCallExpression(n) || ts.isNewExpression(n))) {
        const name = ts.isPropertyAccessExpression(n.expression) ? n.expression.name : n.expression
        let symbol = checker.getSymbolAtLocation(name)
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
        for (const d of symbol?.declarations ?? []) call(d, from)
        const step = n.arguments?.[0]
        if (name.getText() === 'invoke' && step && ts.isStringLiteral(step)) invoked.push([step.text, from])
      }
      n.forEachChild((c) => visit(c, from))
    }
    visit(file, undefined)
  }
  for (const [name, from] of invoked) if (byName.has(name)) call(byName.get(name)!, from)
  const seed = ours.find((f) => f.fileName.endsWith('/llm-attempt-lease.ts'))!.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'driveAttempt')!
  const paid = new Set<ts.Node>([seed])
  for (const queue = [seed]; queue.length;) for (const c of callers.get(queue.pop()!) ?? []) if (!paid.has(c)) { paid.add(c); queue.push(c) }
  return new Set([...paid].map((d) => (d as ts.NamedDeclaration).name?.getText() ?? ''))
}

function wirings(): { file: string; step: string; retries: number }[] {
  const out: { file: string; step: string; retries: number }[] = []
  for (const file of program.getSourceFiles().filter((f) => /\/server\/src\/.*\.workflow\.ts$/.test(f.fileName))) {
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.expression.getText() === 'workflow.do' && n.arguments[1] && ts.isStringLiteral(n.arguments[1])) {
        const options = n.arguments[3]
        const retries = options && ts.isObjectLiteralExpression(options) ? options.properties.find((p) => p.name?.getText() === 'retries') : undefined
        out.push({ file: file.fileName.split('/').pop()!, step: n.arguments[1].text, retries: retries && ts.isPropertyAssignment(retries) ? Number(retries.initializer.getText()) : 0 })
      }
      n.forEachChild(visit)
    }
    visit(file)
  }
  return out
}

test('every workflow wiring of a paid step retries it', () => {
  const paid = paidNames()
  const all = wirings()
  const paidWirings = all.filter((w) => paid.has(w.step))
  // positive controls: the scan reads the wirings, and the derivation finds the known paid steps (and no plain one)
  expect(all.length).toBeGreaterThan(100)
  expect(paidWirings.map((w) => w.step)).toEqual(expect.arrayContaining(['executeLearningConceptAssessmentStep', 'executeLearningAssessmentReplicateStep',
    'respondLearningPlaygroundStep', 'regradeLearningDriftPanelItemStep', 'simActionStep']))
  expect(paid.has('dispatchLearningReactiveConceptsStep')).toBe(false)
  expect(paidWirings.filter((w) => w.retries < 1)).toEqual([])
}, 60_000)

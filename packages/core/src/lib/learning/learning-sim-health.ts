/**
 * Revision 8, the health look (SIM_PREREGISTRATION.primary.sequential.healthLooks): what an operator may read at any
 * time during a batch. ARM-BLIND by construction: nothing here groups, filters or labels by `config.arm` (the
 * never-learns control is told apart by its lane, `none`, which is a design cell, not an arm of the primary), so no
 * between-arm outcome difference can be computed from what it returns. Ids and counts only: no learner, agent or
 * exam text. learning-sim-rules.test.ts ("the health look is arm-blind") checks both properties.
 */
import { HALYARD_FACT_EXAM } from './learning-sim-facts.js'
import { channelIntegrity, final, learnerEcho, mean, neverLearnsControl, unbudgetedAt, type SimLearnerData } from './learning-sim-analysis.js'

const quantile = (xs: number[], q: number) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))]! : NaN }

/** `statuses`: each learner's latest workflow status by learner id (absent: not started). */
export function simHealth(all: SimLearnerData[], statuses: Record<string, string>) {
  const learners = all.filter((d) => d.config.lane !== 'none'), control = all.filter((d) => d.config.lane === 'none')
  const byStatus: Record<string, number> = {}
  for (const d of all) { const s = statuses[d.config.learnerId] ?? 'not started'; byStatus[s] = (byStatus[s] ?? 0) + 1 }
  const calls = all.flatMap((d) => d.calls)
  const roles = [...new Set(calls.map((c) => c.role))].sort()
  const roleHealth = (role: string) => {
    const cs = calls.filter((c) => c.role === role), done = cs.filter((c) => !c.pending)
    return { calls: cs.length, pending: cs.length - done.length, invocations: cs.reduce((n, c) => n + c.invocations, 0), paidMoreThanOnce: done.filter((c) => c.invocations > 1).length,
      parseRetries: done.filter((c) => c.attempts > 1).length, rateLimited: cs.reduce((n, c) => n + (c.rateLimited ?? 0), 0),
      medianSeconds: quantile(done.map((c) => c.durationMs / 1000), 0.5), p90Seconds: quantile(done.map((c) => c.durationMs / 1000), 0.9) }
  }
  const callsByRole: Record<string, ReturnType<typeof roleHealth>> = Object.fromEntries(roles.map((role) => [role, roleHealth(role)]))
  // Per-item exam screening, pooled over every learner of the primary design (never by arm): the share of final exams
  // with full credit on the item, and how many control learners got it right (a never-learns learner should get none).
  const finals = learners.flatMap((d) => final(d) ? [final(d)!] : []), controlFinals = control.flatMap((d) => final(d) ? [final(d)!] : [])
  const items = HALYARD_FACT_EXAM.map((q) => ({ id: q.id, fullCredit: finals.filter((e) => e.points[q.id] === 2).length, of: finals.length, controlRight: controlFinals.filter((e) => (e.points[q.id] ?? 0) > 0).length }))
  const unbudgeted = learners.flatMap((d) => final(d) ? [unbudgetedAt(d, d.config.sessions)?.length] : []).filter((n): n is number => n != null)
  const echo = learnerEcho(learners), channel = channelIntegrity(learners), ctl = neverLearnsControl(control)
  return {
    learners: all.length, byStatus, failed: all.filter((d) => statuses[d.config.learnerId] === 'failed').map((d) => d.config.learnerId).sort(),
    finalExams: finals.length, controlFinalExams: controlFinals.length,
    calls: { total: calls.length, pending: calls.filter((c) => c.pending).length, invocations: calls.reduce((n, c) => n + c.invocations, 0), rateLimited: calls.reduce((n, c) => n + (c.rateLimited ?? 0), 0), byRole: callsByRole },
    gates: {
      unbudgetedPooled: { perLearner: mean(unbudgeted), max: unbudgeted.length ? Math.max(...unbudgeted) : NaN, learners: unbudgeted.length },
      echo: { mean: echo.all.mean, shareHigh: echo.all.shareHigh, n: echo.all.n, ok: echo.ok },
      channel,
      neverLearns: { n: ctl.n, examGainMean: ctl.examGain.mean, toasts: ctl.toasts, rises: ctl.rises, aggregateRises: ctl.aggregateRises, examOk: ctl.examOk, masteryOk: ctl.masteryOk },
    },
    items: { screened: items.length, nearCeiling: items.filter((x) => x.of >= 5 && x.fullCredit / x.of >= 0.9).map((x) => x.id), neverRight: items.filter((x) => x.of >= 5 && x.fullCredit === 0).map((x) => x.id), controlRight: items.filter((x) => x.controlRight > 0).map((x) => x.id) },
  }
}

const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a')
/** The health look as a plain table: ids and counts only. */
export function renderSimHealth(runId: string, h: ReturnType<typeof simHealth>) {
  const okText = (x: boolean | null) => (x === null ? 'n/a' : x ? 'ok' : 'FAIL')
  return [
    `# Health look, run ${runId} (arm-blind: no between-arm number)`, '',
    `Learners ${h.learners}: ${Object.entries(h.byStatus).map(([s, n]) => `${s} ${n}`).join(', ')}. Failed: ${h.failed.join(', ') || 'none'}. Final exams ${h.finalExams} (control ${h.controlFinalExams}).`, '',
    `Calls ${h.calls.total} (pending ${h.calls.pending}), paid invocations ${h.calls.invocations}, 429s ${h.calls.rateLimited}.`, '',
    '| role | calls | pending | invocations | paid > 1 | parse retries | 429s | median s | p90 s |', '|---|---|---|---|---|---|---|---|---|',
    ...Object.entries(h.calls.byRole).map(([role, x]) => `| ${role} | ${x.calls} | ${x.pending} | ${x.invocations} | ${x.paidMoreThanOnce} | ${x.parseRetries} | ${x.rateLimited} | ${f(x.medianSeconds)} | ${f(x.p90Seconds)} |`), '',
    '| gate (pooled) | value | status |', '|---|---|---|',
    `| unbudgeted facts per learner, final exam | ${f(h.gates.unbudgetedPooled.perLearner, 2)} (max ${f(h.gates.unbudgetedPooled.max, 0)}, n ${h.gates.unbudgetedPooled.learners}) | ${Number.isFinite(h.gates.unbudgetedPooled.perLearner) ? (h.gates.unbudgetedPooled.perLearner <= 0.5 ? 'ok' : 'FAIL') : 'n/a'} |`,
    `| learner echo | mean ${f(h.gates.echo.mean, 2)}, share >= 0.7 ${f(100 * h.gates.echo.shareHigh)}% (n ${h.gates.echo.n}) | ${okText(h.gates.echo.ok)} |`,
    `| channel | ${h.gates.channel.turns} turns, claimed unaccounted ${h.gates.channel.claimedUnaccounted}, over budget kept ${h.gates.channel.overBudgetKept} | ${okText(h.gates.channel.ok)} |`,
    `| never-learns control | n ${h.gates.neverLearns.n}, exam gain ${f(h.gates.neverLearns.examGainMean)}, toasts ${h.gates.neverLearns.toasts}, rises ${h.gates.neverLearns.rises} | exam ${okText(h.gates.neverLearns.examOk)}, mastery ${okText(h.gates.neverLearns.masteryOk)} |`, '',
    `Exam items (${h.items.screened}, pooled over arms): full credit on >= 90% of final exams: ${h.items.nearCeiling.join(', ') || 'none'}; never full credit: ${h.items.neverRight.join(', ') || 'none'}; right for the never-learns control: ${h.items.controlRight.join(', ') || 'none'}.`, '',
  ].join('\n')
}

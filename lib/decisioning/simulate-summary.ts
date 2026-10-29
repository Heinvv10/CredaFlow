import type { DecisionFacts } from "./facts"
import type { DecisionKind, RuleDef, RuleOutcome, Verdict } from "./types"

/** What staff did with the application in the real world. */
export type StaffOutcome = "APPROVED" | "DECLINED" | "OPEN"

export interface SimulationEntry {
  facts: DecisionFacts
  /** The champion in force for the application's product; null when none. */
  live: Verdict | null
  candidate: Verdict
  actual: StaffOutcome
}

export interface RuleHitRate {
  ruleId: string
  name: string
  outcome: RuleOutcome
  hits: number
  hitRatePct: number
}

export interface SimulationSummary {
  sampled: number
  /** Applications whose facts included a current bureau check. */
  withBureau: number
  live: Record<DecisionKind, number> | null
  candidate: Record<DecisionKind, number>
  unchanged: number
  /** Movements between live and candidate verdicts ("NONE": no live rules). */
  changes: { from: DecisionKind | "NONE"; to: DecisionKind; count: number }[]
  ruleHits: RuleHitRate[]
  byGrade: Record<string, number>
  againstStaff: { approvedByStaff: number; candidateWouldDecline: number; declinedByStaff: number; candidateWouldApprove: number }
}

const zero = (): Record<DecisionKind, number> => ({ APPROVE: 0, DECLINE: 0, REFER: 0 })
const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10)

/** Counts, movements and per-rule hit rates over a sample. Pure. */
export function summarise(entries: readonly SimulationEntry[], rules: readonly RuleDef[]): SimulationSummary {
  const candidate = zero()
  const anyLive = entries.some((e) => e.live !== null)
  const live = anyLive ? zero() : null
  const moves = new Map<string, { from: DecisionKind | "NONE"; to: DecisionKind; count: number }>()
  const hits = new Map<string, number>()
  const byGrade: Record<string, number> = {}
  const staff = { approvedByStaff: 0, candidateWouldDecline: 0, declinedByStaff: 0, candidateWouldApprove: 0 }
  let unchanged = 0

  for (const e of entries) {
    candidate[e.candidate.decision] += 1
    if (e.live && live) live[e.live.decision] += 1
    const from = e.live?.decision ?? "NONE"
    if (from === e.candidate.decision) unchanged += 1
    else {
      const key = `${from}>${e.candidate.decision}`
      const move = moves.get(key) ?? { from, to: e.candidate.decision, count: 0 }
      move.count += 1
      moves.set(key, move)
    }
    for (const h of e.candidate.hits) hits.set(h.ruleId, (hits.get(h.ruleId) ?? 0) + 1)
    const grade = e.candidate.riskGrade ?? "UNGRADED"
    byGrade[grade] = (byGrade[grade] ?? 0) + 1
    if (e.actual === "APPROVED") {
      staff.approvedByStaff += 1
      if (e.candidate.decision === "DECLINE") staff.candidateWouldDecline += 1
    } else if (e.actual === "DECLINED") {
      staff.declinedByStaff += 1
      if (e.candidate.decision === "APPROVE") staff.candidateWouldApprove += 1
    }
  }

  return {
    sampled: entries.length,
    withBureau: entries.filter((e) => e.facts.bureauAvailable).length,
    live,
    candidate,
    unchanged,
    changes: [...moves.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from)),
    ruleHits: rules.map((r) => ({ ruleId: r.id, name: r.name, outcome: r.outcome, hits: hits.get(r.id) ?? 0, hitRatePct: pct(hits.get(r.id) ?? 0, entries.length) })),
    byGrade,
    againstStaff: staff,
  }
}

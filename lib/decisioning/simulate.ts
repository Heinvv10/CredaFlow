import { sastCalendarDate } from "@/lib/date/sast"
import { prisma } from "@/lib/prisma"
import { decide } from "./decide"
import { loadDecisionFacts } from "./load-facts"
import { pickChampion } from "./select-version"
import { summarise, type SimulationEntry, type SimulationSummary, type StaffOutcome } from "./simulate-summary"
import type { RuleDef, Scorecard } from "./types"
import { parseRules } from "./validate-rules"
import { parseScorecard } from "./validate-scorecard"

export const SIMULATION_DEFAULT_LIMIT = 200
export const SIMULATION_MAX_LIMIT = 500
export const SIMULATION_DEFAULT_DAYS = 180
export const SIMULATION_MAX_DAYS = 730
const BATCH = 10

type Db = Pick<typeof prisma, "loanApplication" | "autoDecisionRun" | "decisionRuleSetVersion" | "tenantConfig" | "creditBureauCheck" | "auditLog" | "loan" | "tenant" | "productVersion" | "productPricingRule" | "applicationPricingInput">

export interface SimulationInput {
  tenantId: string
  /** A draft or an approved version, as stored: rules and scorecard are validated here. */
  candidate: { rules: unknown; scorecard: unknown; productId: string | null }
  sinceDays?: number
  limit?: number
  now?: Date
}

export interface SimulationReport extends SimulationSummary {
  /** Always true: a replay rebuilds facts from the records on file now (bureau, client data), with affordability from the recorded snapshots where there are any. It estimates, it does not reproduce. */
  indicative: true
  window: { from: string; to: string }
  /** The version in force today for the product (or lender-wide) the candidate is compared with; null: none. */
  liveRuleSet: string | null
}

const staffOutcome = (status: string): StaffOutcome =>
  status === "APPROVED" || status === "DISBURSED" ? "APPROVED" : status === "DECLINED" ? "DECLINED" : "OPEN"

/**
 * Replays a candidate rule set and scorecard over the lender's recent real
 * applications and sets the result against the version in force today and
 * against what staff decided. Strictly read-only: nothing is written, no
 * application is touched, no client is contacted. Facts are rebuilt as at each
 * application's submission day (age, bureau currency), from the records on
 * file now; an application with no client borrower is left out.
 */
export async function simulateRuleSet(input: SimulationInput, db: Db = prisma): Promise<SimulationReport> {
  const rules: RuleDef[] = parseRules(input.candidate.rules)
  const scorecard: Scorecard | null = parseScorecard(input.candidate.scorecard)
  const now = input.now ?? new Date()
  const days = input.sinceDays ?? SIMULATION_DEFAULT_DAYS
  if (!Number.isInteger(days) || days < 1 || days > SIMULATION_MAX_DAYS) throw new RangeError(`sinceDays must be a whole number from 1 to ${SIMULATION_MAX_DAYS}`)
  const limit = Math.min(Math.max(1, input.limit ?? SIMULATION_DEFAULT_LIMIT), SIMULATION_MAX_LIMIT)
  const from = new Date(now.getTime() - days * 86_400_000)

  const applications = await db.loanApplication.findMany({
    where: {
      tenantId: input.tenantId, clientId: { not: null }, status: { not: "DRAFT" }, submittedAt: { gte: from, lte: now },
      ...(input.candidate.productId ? { productId: input.candidate.productId } : {}),
    },
    orderBy: { submittedAt: "desc" },
    take: limit,
    select: { id: true, productId: true, status: true, submittedAt: true },
  })

  const versions = await db.decisionRuleSetVersion.findMany({ where: { tenantId: input.tenantId, challengerOnly: false } })
  const refs = versions.map((v) => ({ id: v.id, scopeKey: v.scopeKey, version: v.version, effectiveFrom: v.effectiveFrom.toISOString().slice(0, 10), challengerOnly: v.challengerOnly }))
  const today = sastCalendarDate(now)
  const liveFor = (productId: string) => {
    const champion = pickChampion(refs, productId, today)
    return champion ? { row: versions.find((v) => v.id === champion.id)!, label: `${champion.scopeKey}:v${champion.version}` } : null
  }

  const automated = new Set((await db.autoDecisionRun.findMany({
    where: { tenantId: input.tenantId, applicationId: { in: applications.map((a) => a.id) }, execution: { in: ["APPROVED", "DECLINED"] } },
    select: { applicationId: true },
  })).map((r) => r.applicationId))

  const entries: SimulationEntry[] = []
  for (let i = 0; i < applications.length; i += BATCH) {
    const batch = await Promise.all(applications.slice(i, i + BATCH).map(async (application): Promise<SimulationEntry | null> => {
      const loaded = await loadDecisionFacts(db, input.tenantId, application.id, application.submittedAt ?? now, { preferSnapshot: true })
      if (!loaded) return null
      const live = liveFor(application.productId)
      return {
        facts: loaded.facts,
        live: live ? decide({ facts: loaded.facts, rules: parseRules(live.row.rules), scorecard: parseScorecard(live.row.scorecard) }) : null,
        candidate: decide({ facts: loaded.facts, rules, scorecard }),
        actual: automated.has(application.id) ? "AUTOMATED" : staffOutcome(application.status),
        affordabilitySource: loaded.affordabilitySource,
      }
    }))
    entries.push(...batch.filter((e): e is SimulationEntry => e !== null))
  }

  const labels = new Set(applications.map((a) => liveFor(a.productId)?.label ?? null))
  return {
    ...summarise(entries, rules),
    indicative: true as const,
    window: { from: from.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) },
    liveRuleSet: labels.size === 1 ? ([...labels][0] ?? null) : labels.size > 1 ? "several (by product)" : null,
  }
}

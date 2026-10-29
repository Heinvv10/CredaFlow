import { prisma } from "@/lib/prisma"
import { presentChangeRequest } from "@/lib/maker-checker/http"
import { listChangeRequests } from "@/lib/maker-checker/service"
import { ENGINE_CONFIG_KIND, RULE_SET_KIND } from "./change-payloads"
import { FACT_DEFINITIONS, FACT_NAMES } from "./facts"
import { OPERATORS } from "./types"

const STATS_DAYS = 30

export interface RunStats {
  sinceDays: number
  total: number
  byExecution: Record<string, number>
  byVerdict: Record<string, number>
  byRole: Record<string, number>
  latencyMs: { avg: number; p95: number; max: number } | null
}

const tally = <T extends string>(rows: { key: T; n: number }[]) => Object.fromEntries(rows.map((r) => [r.key, r.n]))

export function latencySummary(values: readonly number[]): RunStats["latencyMs"] {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return {
    avg: Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length),
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    max: sorted[sorted.length - 1],
  }
}

/** Everything the decision-rules settings page shows, for one lender. */
export async function loadDecisioningOverview(tenantId: string, viewer: { id: string; role: string }) {
  const since = new Date(Date.now() - STATS_DAYS * 86_400_000)
  const [versions, config, products, delegates, requests, runs] = await Promise.all([
    prisma.decisionRuleSetVersion.findMany({ where: { tenantId }, orderBy: [{ scopeKey: "asc" }, { version: "desc" }] }),
    prisma.decisionEngineConfig.findUnique({ where: { tenantId } }),
    prisma.loanProduct.findMany({ where: { tenantId, active: true }, select: { id: true, code: true, name: true }, orderBy: { code: "asc" } }),
    prisma.user.findMany({ where: { tenantId, active: true, role: { in: ["LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"] } }, select: { id: true, name: true, email: true, role: true }, orderBy: { email: "asc" } }),
    Promise.all([RULE_SET_KIND, ENGINE_CONFIG_KIND].map((kind) => listChangeRequests(tenantId, { kind }))).then((lists) => lists.flat()),
    prisma.autoDecisionRun.findMany({ where: { tenantId, createdAt: { gte: since } }, select: { execution: true, verdict: true, role: true, latencyMs: true }, take: 5000 }),
  ])
  const count = <K extends "execution" | "verdict" | "role">(key: K) => {
    const m = new Map<string, number>()
    for (const r of runs) m.set(r[key], (m.get(r[key]) ?? 0) + 1)
    return tally([...m].map(([k, n]) => ({ key: k, n })))
  }
  const stats: RunStats = {
    sinceDays: STATS_DAYS, total: runs.length, byExecution: count("execution"), byVerdict: count("verdict"), byRole: count("role"),
    latencyMs: latencySummary(runs.map((r) => r.latencyMs)),
  }
  return {
    facts: FACT_NAMES.map((name) => ({ name, ...FACT_DEFINITIONS[name] })),
    operators: [...OPERATORS],
    products,
    delegates,
    versions: versions.map((v) => ({
      id: v.id, scopeKey: v.scopeKey, productId: v.productId, version: v.version, name: v.name, rules: v.rules, scorecard: v.scorecard,
      effectiveFrom: v.effectiveFrom.toISOString().slice(0, 10), challengerOnly: v.challengerOnly, changeRequestId: v.changeRequestId, createdAt: v.createdAt.toISOString(),
    })),
    config: config
      ? { mode: config.mode, channels: config.channels, productIds: config.productIds, delegateUserId: config.delegateUserId, repaymentMethod: config.repaymentMethod, challengerVersionId: config.challengerVersionId, challengerPercent: config.challengerPercent }
      : { mode: "OFF" as const, channels: [] as string[], productIds: [] as string[], delegateUserId: null, repaymentMethod: "EFT" as const, challengerVersionId: null, challengerPercent: 0 },
    requests: requests
      .filter((r) => r.status === "DRAFT" || r.status === "SUBMITTED" || r.decidedAt === null || Date.now() - r.decidedAt.getTime() < 14 * 86_400_000)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => presentChangeRequest(r, viewer.id, viewer.role)),
    stats,
  }
}

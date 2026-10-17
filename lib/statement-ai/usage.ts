/**
 * Metering: one StatementAiUsage row per model call, for per-statement
 * pricing later (goal §5). Never blocks a call: a failed write is logged and
 * the output is still stored.
 */
import type { StatementAiKind } from "@prisma/client"
import { prisma } from "@/lib/prisma"

export interface UsageRecord {
  tenantId: string
  applicationId: string
  kind: StatementAiKind
  tokensIn: number | null
  tokensOut: number | null
  latencyMs: number
}

export async function recordUsage(u: UsageRecord): Promise<void> {
  try {
    await prisma.statementAiUsage.create({ data: u })
  } catch (err) {
    console.error("[statement-ai] usage not recorded:", { kind: u.kind, error: err instanceof Error ? err.name : "unknown" })
  }
}

export interface MonthlyUsage {
  kind: StatementAiKind
  calls: number
  applications: number
  tokensIn: number
  tokensOut: number
}

/** A tenant's calls in one calendar month (UTC), per kind. `month` is YYYY-MM. */
export async function monthlyUsage(tenantId: string, month: string): Promise<MonthlyUsage[]> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("month must be YYYY-MM")
  const from = new Date(`${month}-01T00:00:00Z`)
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1))
  const rows = await prisma.$queryRaw<Array<{ kind: StatementAiKind; calls: bigint; applications: bigint; tokensIn: bigint | null; tokensOut: bigint | null }>>`
    SELECT "kind", COUNT(*) AS "calls", COUNT(DISTINCT "applicationId") AS "applications",
           SUM("tokensIn") AS "tokensIn", SUM("tokensOut") AS "tokensOut"
    FROM "StatementAiUsage"
    WHERE "tenantId" = ${tenantId} AND "createdAt" >= ${from} AND "createdAt" < ${to}
    GROUP BY "kind" ORDER BY "kind"`
  return rows.map((r) => ({ kind: r.kind, calls: Number(r.calls), applications: Number(r.applications), tokensIn: Number(r.tokensIn ?? 0), tokensOut: Number(r.tokensOut ?? 0) }))
}

import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { runAutoDecisionSafely } from "@/lib/decisioning/run-safely"
import { getRiskGrade } from "@/lib/decisioning/risk-grade"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"

type Ctx = { params: Promise<{ id: string }> }

/** What the decision engine did with this application: its runs (newest first) and its risk grade. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await ctx.params
    const runs = await prisma.autoDecisionRun.findMany({
      where: { tenantId: tenant.id, applicationId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { ruleSetVersion: { select: { scopeKey: true, version: true, name: true } } },
    })
    return NextResponse.json({
      riskGrade: await getRiskGrade(prisma, tenant.id, id),
      runs: runs.map((r) => ({
        id: r.id, createdAt: r.createdAt, mode: r.mode, role: r.role, trigger: r.trigger, verdict: r.verdict, execution: r.execution,
        reasonCodes: r.reasonCodes, riskGrade: r.riskGrade, score: r.score, latencyMs: r.latencyMs, note: r.executionNote,
        ruleSet: `${r.ruleSetVersion.scopeKey}:v${r.ruleSetVersion.version}`, ruleSetName: r.ruleSetVersion.name,
      })),
    })
  })
}

/** Runs the engine now (the lender's settings decide whether it acts). LOAN_ADMIN and above. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await ctx.params
    const outcome = await runAutoDecisionSafely({ tenantId: tenant.id, applicationId: id, trigger: "MANUAL" })
    if (!outcome) return NextResponse.json({ error: "The decision engine could not run; the application stays with staff." }, { status: 500 })
    return NextResponse.json(outcome.status === "RAN"
      ? { status: "RAN", execution: outcome.execution, decision: outcome.verdict.decision, reasonCodes: outcome.verdict.reasonCodes, riskGrade: outcome.verdict.riskGrade, ruleSet: outcome.ruleSet, role: outcome.role, latencyMs: outcome.latencyMs, note: outcome.note }
      : outcome)
  })
}

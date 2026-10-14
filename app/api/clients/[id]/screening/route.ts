import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { readClientScreening } from "@/lib/screening/gate"
import { runScreening } from "@/lib/screening/run"
import { screeningStateMessage } from "@/lib/screening/state"

/**
 * GET  /api/clients/[id]/screening — the client's screening state and latest run.
 * POST /api/clients/[id]/screening — screen the client now (audited by runScreening).
 *
 * CREDIT_OFFICER and up: the people who need to know why an approval is held.
 * Deciding a match is a separate, senior route (/api/screening/checks/[id]/review).
 */
async function clientInTenant(tenantId: string, clientId: string): Promise<boolean> {
  const client = await prisma.client.findFirst({ where: { id: clientId, tenantId }, select: { id: true } })
  return client !== null
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await ctx.params
    if (!(await clientInTenant(tenant.id, id))) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 })
    }
    const current = await readClientScreening(tenant.id, id)
    const checks = current.runId
      ? await prisma.screeningCheck.findMany({
          where: { tenantId: tenant.id, runId: current.runId },
          orderBy: { type: "asc" },
          select: {
            id: true, type: true, result: true, matches: true, simulated: true, provider: true,
            trigger: true, errorCode: true, decision: true, decisionReason: true,
            reviewedById: true, reviewedAt: true, carriedFromCheckId: true, createdAt: true,
          },
        })
      : []
    return NextResponse.json({
      state: current.state,
      message: screeningStateMessage(current.state),
      runAt: current.runAt,
      checks,
    })
  })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await ctx.params
    if (!(await clientInTenant(tenant.id, id))) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 })
    }
    const ran = await runScreening({
      tenantId: tenant.id,
      clientId: id,
      trigger: "MANUAL",
      actor: { id: guard.user.id, email: guard.user.email },
    })
    if (!ran.configured) {
      return NextResponse.json({ error: screeningStateMessage({ state: "NOT_CONFIGURED" }) }, { status: 409 })
    }
    // A provider failure is recorded (state INCOMPLETE) and surfaced, never retried silently.
    return NextResponse.json(
      {
        runId: ran.runId,
        state: ran.state,
        message: screeningStateMessage(ran.state),
        ...(ran.providerError ? { providerError: ran.providerError } : {}),
      },
      { status: ran.providerError ? 502 : 200 },
    )
  })
}

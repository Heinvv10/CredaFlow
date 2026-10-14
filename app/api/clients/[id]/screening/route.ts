import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { screenSubjectNow, subjectScreeningResponse } from "@/lib/screening/subject-route"

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
    if (!(await clientInTenant(tenant.id, id))) return NextResponse.json({ error: "Client not found" }, { status: 404 })
    return subjectScreeningResponse(tenant.id, { clientId: id })
  })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await ctx.params
    if (!(await clientInTenant(tenant.id, id))) return NextResponse.json({ error: "Client not found" }, { status: 404 })
    return screenSubjectNow(tenant.id, { clientId: id }, { id: guard.user.id, email: guard.user.email })
  })
}

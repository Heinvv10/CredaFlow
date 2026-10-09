import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import { generateUniqueReferralCode, normaliseReferralCode } from "@/lib/referral-agents/referrals"

function clean(value: unknown, max = 160) {
  return typeof value === "string" ? value.trim().slice(0, max) : ""
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const body = await req.json() as { agentId?: string; code?: string; label?: string; campaign?: string }
    const agentId = clean(body.agentId, 64)
    if (!agentId) return NextResponse.json({ error: "agentId is required" }, { status: 400 })

    const agent = await prisma.referralAgent.findFirst({ where: { id: agentId, tenantId: tenant.id }, select: { id: true, displayName: true } })
    if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 })

    const code = normaliseReferralCode(body.code) ?? await generateUniqueReferralCode(prisma, tenant.id)
    const existing = await prisma.referralCode.findUnique({ where: { tenantId_code: { tenantId: tenant.id, code } }, select: { id: true } })
    if (existing) return NextResponse.json({ error: `Referral code ${code} already exists` }, { status: 409 })

    let referralCode
    try {
      referralCode = await prisma.referralCode.create({
        data: {
          tenantId: tenant.id,
          agentId,
          code,
          label: clean(body.label, 120) || null,
          campaign: clean(body.campaign, 120) || null,
        },
      })
    } catch (error) {
      // A concurrent create with the same tenant+code races the existence
      // check above and hits @@unique([tenantId, code]); surface a clean 409.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return NextResponse.json({ error: `Referral code ${code} already exists` }, { status: 409 })
      }
      throw error
    }

    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: "REFERRAL_CODE_CREATED",
      entity: "ReferralCode",
      entityId: referralCode.id,
      newValue: { agentId, agentName: agent.displayName, code, label: referralCode.label, campaign: referralCode.campaign },
    })

    return NextResponse.json(referralCode, { status: 201 })
  })
}

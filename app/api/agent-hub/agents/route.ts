import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { normaliseReferralCode } from "@/lib/referral-agents/referrals"

type RecentEvent = {
  eventType: string
  source: string | null
  amountCents: number | null
  commissionStatus: string
  qualityFlag: string | null
  createdAt: Date
  code: { code: string; label: string | null } | null
  agent: { displayName: string } | null
}

export async function GET(req: Request) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req as never, async (tenant) => {
    const [agents, activeAgents, activeReferralCodes, totalReferralEvents, websiteLeads, recentEvents] = await Promise.all([
      prisma.referralAgent.findMany({
        where: { tenantId: tenant.id },
        orderBy: { createdAt: "desc" },
        include: { referralCodes: true, _count: { select: { referralEvents: true } } },
      }),
      prisma.referralAgent.count({ where: { tenantId: tenant.id, status: "ACTIVE" } }),
      prisma.referralCode.count({ where: { tenantId: tenant.id, status: "ACTIVE" } }),
      prisma.referralEvent.count({ where: { tenantId: tenant.id } }),
      prisma.lead.count({ where: { tenantId: tenant.id, tags: { has: "referral-application" } } }),
      prisma.referralEvent.findMany({
        where: { tenantId: tenant.id },
        orderBy: { createdAt: "desc" },
        take: 6,
        select: {
          eventType: true,
          source: true,
          amountCents: true,
          commissionStatus: true,
          qualityFlag: true,
          createdAt: true,
          code: { select: { code: true, label: true } },
          agent: { select: { displayName: true } },
        },
      }),
    ])

    return NextResponse.json({
      agents,
      metrics: {
        activeAgents,
        activeReferralCodes,
        totalReferralEvents,
        websiteLeads,
      },
      recentEvents: (recentEvents as RecentEvent[]).map((event) => ({
        eventType: event.eventType,
        source: event.source,
        amount: event.amountCents ? event.amountCents / 100 : null,
        commissionStatus: event.commissionStatus,
        qualityFlag: event.qualityFlag,
        createdAt: event.createdAt.toISOString(),
        code: event.code?.code ?? null,
        codeLabel: event.code?.label ?? null,
        agentName: event.agent?.displayName ?? null,
      })),
    })
  })
}

export async function POST(req: Request) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req as never, async (tenant) => {
    const data = await req.json()
    const displayName = String(data.displayName ?? "").trim()
    const code = normaliseReferralCode(data.code)

    if (!displayName) return NextResponse.json({ error: "displayName is required" }, { status: 400 })
    if (!code) return NextResponse.json({ error: "A valid referral code is required" }, { status: 400 })

    const result = await prisma.$transaction(async (tx) => {
      const agent = await tx.referralAgent.create({
        data: {
          tenantId: tenant.id,
          displayName,
          legalName: data.legalName ? String(data.legalName).trim() : null,
          phone: data.phone ? String(data.phone).trim() : null,
          email: data.email ? String(data.email).trim().toLowerCase() : null,
          channel: data.channel ? String(data.channel).trim().toUpperCase() : "FIELD",
          notes: data.notes ? String(data.notes).trim() : null,
        },
      })
      const referralCode = await tx.referralCode.create({
        data: {
          tenantId: tenant.id,
          agentId: agent.id,
          code,
          label: data.label ? String(data.label).trim() : null,
          campaign: data.campaign ? String(data.campaign).trim() : null,
        },
      })
      return { agent, referralCode }
    })

    return NextResponse.json(result, { status: 201 })
  })
}

import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { sendEmail } from "@/lib/email/service"
import { getTenantFromRequest } from "@/lib/tenant"
import { verifyCronSecret } from "@/lib/cron-auth"

const STALE_HOURS = 48
const ACTIVE_STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "PROPOSAL_SENT"] as const

function staleLeadEmail(agentName: string, leads: { name: string; status: string; daysStale: number }[]): string {
  const rows = leads
    .map(
      (l) =>
        `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0">${l.name}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;color:#6B7280">${l.status.replace(/_/g, " ")}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;color:#EF4444;font-weight:600">${l.daysStale}d</td>
        </tr>`
    )
    .join("")

  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;color:#111827;max-width:600px;margin:0 auto;padding:24px">
  <p style="font-size:15px">Hi ${agentName},</p>
  <p style="font-size:15px">You have <strong>${leads.length} stale lead${leads.length !== 1 ? "s" : ""}</strong> that have had no activity for over ${STALE_HOURS} hours.</p>
  <table style="width:100%;border-collapse:collapse;margin:16px 0">
    <thead>
      <tr style="background:#F9FAFB">
        <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#9CA3AF">Lead</th>
        <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#9CA3AF">Stage</th>
        <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#9CA3AF">Days Stale</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="font-size:13px;color:#6B7280">Please follow up with these leads today to keep the pipeline moving.</p>
</body>
</html>`
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const tenant = await getTenantFromRequest(req)
  if (!tenant) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 400 })
  }

  const staleThreshold = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000)

  const staleLeads = await prisma.lead.findMany({
    where: {
      tenantId: tenant.id,
      status: { in: [...ACTIVE_STATUSES] },
      updatedAt: { lt: staleThreshold },
      assignedToId: { not: null },
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      status: true,
      updatedAt: true,
      assignedToId: true,
    },
  })

  if (staleLeads.length === 0) {
    console.log("[cron/stale-leads-alert] No stale leads found")
    return NextResponse.json({ sent: 0, total: 0 })
  }

  // Group by assigned agent
  const byAgent = new Map<string, typeof staleLeads>()
  for (const lead of staleLeads) {
    const agentId = lead.assignedToId!
    if (!byAgent.has(agentId)) byAgent.set(agentId, [])
    byAgent.get(agentId)!.push(lead)
  }

  const agentIds = [...byAgent.keys()]
  const agents = await prisma.user.findMany({
    where: { id: { in: agentIds }, active: true },
    select: { id: true, name: true, email: true },
  })

  const agentMap = new Map(agents.map((a) => [a.id, a]))
  let sent = 0

  for (const [agentId, leads] of byAgent) {
    const agent = agentMap.get(agentId)
    if (!agent?.email) continue

    const agentName = agent.name ?? "Agent"
    const now = Date.now()
    const payload = leads.map((l) => ({
      name: `${l.firstName} ${l.lastName}`,
      status: l.status,
      daysStale: Math.floor((now - new Date(l.updatedAt).getTime()) / 86400000),
    }))

    const result = await sendEmail({
      tenantId: tenant.id,
      to: agent.email,
      toName: agentName,
      subject: `${leads.length} stale lead${leads.length !== 1 ? "s" : ""} need your attention`,
      html: staleLeadEmail(agentName, payload),
      category: "stale_leads_alert",
    })

    if (result.ok) {
      sent++
      console.log(`[cron/stale-leads-alert] Sent to ${agent.email} (${leads.length} leads)`)
    } else {
      console.error(`[cron/stale-leads-alert] Failed for ${agent.email}: ${result.error}`)
    }
  }

  console.log(`[cron/stale-leads-alert] Done — ${sent}/${byAgent.size} agents notified, ${staleLeads.length} stale leads`)
  return NextResponse.json({ sent, total: staleLeads.length })
}

import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { pollTenantInbox } from "@/lib/email/inbound-poll"

// Admin-triggered "Poll Inbox" (Settings → Email). The same poll runs
// automatically via /api/cron/email-poll — see lib/email/inbound-poll.ts.
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const config = await prisma.emailConfig.findUnique({ where: { tenantId: tenant.id } })
    if (!config || !config.active) return NextResponse.json({ ok: false, message: "Email not configured" })
    const result = await pollTenantInbox(config, tenant.id)
    return NextResponse.json(result)
  })
}

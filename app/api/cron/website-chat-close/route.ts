import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { closeIdleChats } from "@/lib/website-chat/auto-close"

/**
 * Hourly: closes website chats idle for 24h unless handed off to staff
 * (lib/website-chat/auto-close.ts). Any failed tenant makes the response 503:
 * the scheduler treats only a non-2xx as a failure, and never reads the body.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const now = new Date()
  const tenants = await prisma.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" } })
  const perTenant: Array<{ tenantId: string; closed: number } | { tenantId: string; error: string }> = []
  for (const { id: tenantId } of tenants) {
    try {
      perTenant.push({ tenantId, ...(await runWithTenant(tenantId, () => closeIdleChats(tenantId, now))) })
    } catch (error) {
      perTenant.push({ tenantId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const ok = perTenant.every((t) => !("error" in t))
  return NextResponse.json({ ok, runAt: now.toISOString(), perTenant }, { status: ok ? 200 : 503 })
}

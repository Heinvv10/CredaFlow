import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { sweepHandoffs } from "@/lib/website-chat/handoff-sweep"

/**
 * Every minute: times out website-chat hand-offs nobody joined, emails staff about
 * them, and hands abandoned takeovers back to the assistant
 * (lib/website-chat/handoff-sweep.ts). A failed tenant or a failed
 * email makes the response 503: the scheduler treats only a non-2xx as a
 * failure, and never reads the body.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const now = new Date()
  const tenants = await prisma.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" } })
  const perTenant: Array<{ tenantId: string; expired: number; emailed: number; failed: number; released: number } | { tenantId: string; error: string }> = []
  for (const { id: tenantId } of tenants) {
    try {
      perTenant.push({ tenantId, ...(await runWithTenant(tenantId, () => sweepHandoffs(tenantId, now))) })
    } catch (error) {
      perTenant.push({ tenantId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const ok = perTenant.every((t) => !("error" in t) && t.failed === 0)
  return NextResponse.json({ ok, runAt: now.toISOString(), perTenant }, { status: ok ? 200 : 503 })
}

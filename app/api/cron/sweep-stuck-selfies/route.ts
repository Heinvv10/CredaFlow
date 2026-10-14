import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { sweepStuckSelfies } from "@/lib/kyc/selfie-sweeper.server"

/**
 * Every 5 minutes: fails selfie attempts stuck in `processing` past the
 * timeout (lib/kyc/selfie-sweeper.server.ts), so a client whose worker died
 * can retake. Each swept attempt is an adverse, non-verifying result. Any
 * failed tenant or row makes the response 503: the scheduler treats only a non-2xx
 * as a failure, and never reads the body.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const now = new Date()
  const tenants = await prisma.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" } })
  const perTenant: Array<{ tenantId: string; swept: number; failed: number } | { tenantId: string; error: string }> = []
  for (const { id: tenantId } of tenants) {
    try {
      perTenant.push({ tenantId, ...(await runWithTenant(tenantId, () => sweepStuckSelfies(tenantId))) })
    } catch (error) {
      perTenant.push({ tenantId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const ok = perTenant.every((t) => !("error" in t) && t.failed === 0)
  return NextResponse.json({ ok, runAt: now.toISOString(), perTenant }, { status: ok ? 200 : 503 })
}

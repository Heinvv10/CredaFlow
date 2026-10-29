import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { runAuditChainVerification } from "@/lib/audit/verify-job"
import { FAILED_TENANTS_HEADER } from "@/lib/ops/cron-call"

/**
 * Daily AuditLog hash-chain verification (lib/audit/verify-job.ts). 200 when
 * every chain holds; 500 with the first break of each broken chain when not,
 * so /api/health and the scheduler's retry see it. The broken-chain count is in
 * the x-cron-failed-tenants header (a chain is a tenant's, or the platform's).
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const result = await runAuditChainVerification()
  return NextResponse.json(
    { runAt: new Date().toISOString(), ...result },
    { status: result.ok ? 200 : 500, headers: { [FAILED_TENANTS_HEADER]: String(result.breaks.length) } },
  )
}

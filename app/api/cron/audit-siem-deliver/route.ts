import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { deliverSiemOutbox } from "@/lib/audit/siem/deliver"

/**
 * Ships the SIEM outbox (lib/audit/siem/deliver.ts). A lender whose SIEM is
 * down is retried with backoff and does not fail the job; a tenant that threw
 * (a sealed secret that will not open, a database fault) is counted, and the
 * status is 503 only when every tenant with work failed.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const result = await deliverSiemOutbox()
  const allFailed = result.tenants > 0 && result.failedTenants === result.tenants
  return NextResponse.json({ ok: !allFailed, runAt: new Date().toISOString(), ...result }, { status: allFailed ? 503 : 200 })
}

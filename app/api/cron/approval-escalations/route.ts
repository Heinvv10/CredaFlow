import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { escalateOverdueApprovals } from "@/lib/approval/escalation"

/**
 * Every 15 minutes: escalates approvals that are overdue at their level to the next level up and reminds the top level
 * (lib/approval/escalation.ts). Claimed by each case's due time, so concurrent replicas never escalate one twice. A failed case
 * makes the response 503: the scheduler treats only a non-2xx as a failure, and never reads the body.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied
  const result = await escalateOverdueApprovals()
  return NextResponse.json({ ok: result.failed === 0, runAt: new Date().toISOString(), ...result }, { status: result.failed === 0 ? 200 : 503 })
}

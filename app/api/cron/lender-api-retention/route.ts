import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { pruneLenderApiLogs } from "@/lib/lender-api/retention"

/**
 * Nightly: deletes lender API request logs and finished webhook deliveries
 * (and their events) past their retention (lib/lender-api/retention.ts;
 * API_LOG_RETENTION_DAYS, WEBHOOK_LOG_RETENTION_DAYS).
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied
  const result = await pruneLenderApiLogs()
  return NextResponse.json({ ok: true, ...result })
}

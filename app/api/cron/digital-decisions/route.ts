import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { sweepDigitalDecisions } from "@/lib/decisioning/digital-due"

/**
 * Every 5 minutes: runs the automatic review of digitally submitted applications whose
 * after-response task never finished (a restart, a crash): each is a row the submission
 * wrote first (lib/decisioning/digital-due.ts). Rows are claimed, so concurrent replicas
 * do not run one twice. Any failed row makes the response 503: the scheduler treats only
 * a non-2xx as a failure, and never reads the body.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied
  const result = await sweepDigitalDecisions()
  return NextResponse.json({ ok: result.failed === 0, runAt: new Date().toISOString(), ...result }, { status: result.failed === 0 ? 200 : 503 })
}

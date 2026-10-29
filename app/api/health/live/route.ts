import { NextResponse } from "next/server"

/**
 * Liveness probe: the process answers HTTP. No database or storage check, so a
 * database outage restarts nothing; /api/health/ready takes the pod out of the
 * Service instead.
 */
export function GET() {
  return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } })
}

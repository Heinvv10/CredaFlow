import { timingSafeEqual } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"

/**
 * Verifies the `x-cron-secret` header matches the CRON_SECRET env var
 * using a timing-safe comparison. Returns a 401 NextResponse on failure
 * or null on success.
 *
 * Usage:
 *   const denied = verifyCronSecret(req)
 *   if (denied) return denied
 *   // ...cron body...
 */
export function verifyCronSecret(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 })
  }
  const provided = req.headers.get("x-cron-secret") ?? ""

  const expectedBuf = Buffer.from(cronSecret, "utf8")
  const providedBuf = Buffer.from(provided, "utf8")
  if (expectedBuf.byteLength !== providedBuf.byteLength) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (!timingSafeEqual(expectedBuf, providedBuf)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  return null
}

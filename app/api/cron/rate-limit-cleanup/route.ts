import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { verifyCronSecret } from "@/lib/cron-auth"

/**
 * Purges rate-limit rows whose window has passed (lib/rate-limit-store.ts). A row
 * past `expiresAt` holds no hit that still counts, so deleting it changes no
 * decision; without this the table grows by one row per distinct key ever limited.
 * Not tenant-scoped, idempotent, sends nothing: every replica may run it. The
 * clock is the database's, the one the hits were stamped with.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  try {
    const deleted = await prisma.$executeRaw`DELETE FROM "RateLimitHit" WHERE "expiresAt" < now()`
    return NextResponse.json({ ok: true, deleted, runAt: new Date().toISOString() })
  } catch (error) {
    console.error("[cron/rate-limit-cleanup] purge failed:", error)
    return NextResponse.json({ ok: false, error: "purge failed" }, { status: 503 })
  }
}

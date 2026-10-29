import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { verifyCronSecret } from "@/lib/cron-auth"
import { capRowsPerGroup, groupsOverCap, purgeExpired } from "@/lib/rate-limit-cleanup"

/**
 * Purges rate-limit rows whose window has passed (lib/rate-limit-store.ts), then caps each
 * limiter group's row count (lib/rate-limit-cleanup.ts). A row past `expiresAt` holds no hit
 * that still counts, so deleting it changes no decision; without this the table grows by one
 * row per distinct key ever limited.
 * Not tenant-scoped, idempotent, sends nothing: every replica may run it. The
 * clock is the database's, the one the hits were stamped with.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  try {
    const deleted = await purgeExpired(prisma)
    const capped = await capRowsPerGroup(prisma)
    if (capped > 0) console.warn(`[cron/rate-limit-cleanup] a limiter group exceeded its row ceiling; ${capped} least recently used, unlocked rows removed`)
    // Whatever is still over the ceiling cannot be evicted (an authentication group, or rows that are lockouts): say so.
    const overCap = await groupsOverCap(prisma)
    for (const g of overCap) console.error(`[cron/rate-limit-cleanup] ALERT: limiter group "${g.ns}" holds ${g.rows} rows, over its ceiling; check for a flood of made-up keys`)
    return NextResponse.json({ ok: true, deleted, capped, overCap, runAt: new Date().toISOString() })
  } catch (error) {
    console.error("[cron/rate-limit-cleanup] purge failed:", error)
    return NextResponse.json({ ok: false, error: "purge failed" }, { status: 503 })
  }
}

import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { processTrackerClosures } from "@/lib/asset-finance/tracker-closure"

/**
 * Every 15 minutes: for each tracker on a loan that completed, the borrower's
 * portal notice, email (sendMessage: consent and kill switches as ever) and
 * stored letter, each once (lib/asset-finance/tracker-closure.ts). Idempotent.
 * Answers 503 with the counts when any closure or tenant failed.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied
  const tenants = await prisma.trackerClosure.findMany({
    where: { OR: [{ noticeLoggedAt: null }, { messageDecidedAt: null }, { letterGeneratedAt: null }] }, distinct: ["tenantId"], select: { tenantId: true },
  })
  const run = { ok: true, tenants: 0, closures: 0, failed: 0 }
  for (const { tenantId } of tenants) {
    run.tenants++
    try {
      const done = await runWithTenant(tenantId, () => processTrackerClosures(tenantId))
      run.closures += done.closures
      run.failed += done.failed
    } catch (error) {
      run.failed++
      console.error("[tracker-closure] tenant failed", { tenantId, error: error instanceof Error ? error.message : "unknown" })
    }
  }
  run.ok = run.failed === 0
  return NextResponse.json(run, { status: run.ok ? 200 : 503 })
}

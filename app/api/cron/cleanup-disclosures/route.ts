import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { cleanupOrphanedDisclosures } from "@/scripts/cleanup-orphaned-disclosures"

/**
 * Cleanup Cron — removes disclosure PDFs older than 7 days from uploads/disclosures/.
 *
 * Intended to run nightly (e.g. 02:00 SAST). Files are temporary drafts generated
 * during the FAIS pre-disclosure flow and should not persist after the policy is
 * either accepted or abandoned.
 *
 * Auth: x-cron-secret header must match CRON_SECRET env var.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const result = await cleanupOrphanedDisclosures()

  return NextResponse.json({
    ok: true,
    ...result,
    runAt: new Date().toISOString(),
  })
}

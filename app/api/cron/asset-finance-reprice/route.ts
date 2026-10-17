import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { verifyCronSecret } from "@/lib/cron-auth"
import { sastCalendarDate } from "@/lib/date/sast"
import { dispatchRepriceNotices } from "@/lib/asset-finance/reprice-notice-dispatch"
import { runRepriceBatch } from "@/lib/asset-finance/reprice-batch"

/**
 * Asset-finance repricing cron: applies every reference-rate change effective
 * on or before today (SAST) to the linked loans (lib/asset-finance/
 * reprice-batch.ts). Idempotent, so it is safe to run any number of times a
 * day. Answers 503 with the counts when any loan failed.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const run = await runRepriceBatch(prisma, sastCalendarDate(new Date()))
  const notices = []
  for (const tenant of run.perTenant) notices.push({ tenantId: tenant.tenantId, ...await dispatchRepriceNotices(prisma, tenant.tenantId) })
  const ok = run.ok && notices.every((notice) => notice.pending === 0)
  return NextResponse.json({ ...run, ok, notices }, { status: ok ? 200 : 503 })
}

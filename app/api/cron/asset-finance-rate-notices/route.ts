import { NextRequest, NextResponse } from "next/server"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { prisma } from "@/lib/prisma"
import { verifyCronSecret } from "@/lib/cron-auth"
import { scanRateNoticeDeadlines } from "@/lib/asset-finance/rate-notice-deadline"
import { dispatchRepriceNotices } from "@/lib/asset-finance/reprice-notice-dispatch"

/** Independent notice worker: a repricing/calculation failure cannot hide an existing obligation. */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied
  const deadlines = await scanRateNoticeDeadlines(prisma)
  const tenants = await withoutTenantScope(() =>
    prisma.assetFinanceRateNotice.findMany({
      where: { completedAt: null },
      distinct: ["tenantId"],
      select: { tenantId: true },
    })
  )
  const notices = []
  for (const tenant of tenants)
    notices.push({ tenantId: tenant.tenantId, ...(await dispatchRepriceNotices(prisma, tenant.tenantId)) })
  const after = await scanRateNoticeDeadlines(prisma)
  const ok = notices.every((notice) => notice.pending === 0)
  return NextResponse.json(
    { ok, deadlines: { escalated: deadlines.escalated + after.escalated }, notices },
    { status: ok ? 200 : 503 }
  )
}

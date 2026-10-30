import { NextRequest, NextResponse } from "next/server"
import { ncaOnlyCronSkip } from "@/lib/jurisdiction/nca-only"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { prisma } from "@/lib/prisma"
import { verifyCronSecret } from "@/lib/cron-auth"
import { scanRateNoticeDeadlines } from "@/lib/asset-finance/rate-notice-deadline"
import { dispatchRepriceNotices } from "@/lib/asset-finance/reprice-notice-dispatch"

/** Independent notice worker: a repricing/calculation failure cannot hide an existing obligation. */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied
  // Asset finance is an NCA product: nothing to do for a lender outside the NCA's jurisdiction.
  const skipped = await ncaOnlyCronSkip()
  if (skipped) return skipped
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

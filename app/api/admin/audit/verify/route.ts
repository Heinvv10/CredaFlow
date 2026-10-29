import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { checkRateLimit } from "@/lib/rate-limit"
import { verifyAuditChains } from "@/lib/audit/chain-verify"
import { chainHead, checkpoints } from "@/lib/audit/store"

/**
 * The signed-in lender's audit chain. ADMIN and above; the lender's own chain only.
 *
 * GET reads state, no walk: the latest checkpoint and the last verification results the
 * daily job recorded. POST walks the chain from its latest checkpoint now and reports
 * the first broken link (rate-limited: it reads every link since the checkpoint). A walk
 * from the genesis is `npm run audit:verify`, run by an operator.
 */
const VERIFY_LIMIT = { limit: 6, windowMs: 3_600_000 } as const

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    if (guard.user.tenantId !== tenant.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const checkpoint = (await checkpoints(prisma, tenant.id)).at(-1)
    const head = await chainHead(prisma, tenant.id)
    const results = await prisma.auditLog.findMany({
      where: { tenantId: tenant.id, action: { in: ["AUDIT_CHAIN_VERIFIED", "AUDIT_CHAIN_BROKEN"] } },
      orderBy: { createdAt: "desc" }, take: 10, select: { action: true, createdAt: true, newValue: true },
    })
    return NextResponse.json({ chainedThroughSeq: head?.seq ?? 0, latestCheckpoint: checkpoint ? { seq: checkpoint.seq, createdAt: checkpoint.createdAt } : null, recentResults: results })
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    if (guard.user.tenantId !== tenant.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    if (!checkRateLimit(`audit-verify:${tenant.id}`, VERIFY_LIMIT).allowed) {
      return NextResponse.json({ error: "Too many verifications. Try again later." }, { status: 429 })
    }
    const result = await verifyAuditChains(prisma, { chainKey: tenant.id, mode: "incremental" })
    return NextResponse.json({ ...result, checkedAt: new Date().toISOString() })
  })
}

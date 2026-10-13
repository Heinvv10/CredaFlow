import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { dbDate, isoOfDbDate } from "@/lib/asset-finance/rates-store"
import { parseReferenceRateInput } from "@/lib/asset-finance/reference-rate-input"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"

const view = (row: { id: string; basis: string; effectiveDate: Date; rate: Prisma.Decimal; createdById: string | null; createdAt: Date }) => ({
  id: row.id,
  basis: row.basis,
  effectiveDate: isoOfDbDate(row.effectiveDate),
  rate: row.rate.toString(),
  createdById: row.createdById,
  createdAt: row.createdAt,
})

/** The tenant's reference-rate history, newest first per basis. */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const rows = await prisma.referenceRate.findMany({
      where: { tenantId: tenant.id },
      orderBy: [{ basis: "asc" }, { effectiveDate: "desc" }],
    })
    return NextResponse.json(rows.map(view))
  })
}

/**
 * Records a reference-rate value from its effective date. The repricing cron
 * (app/api/cron/asset-finance-reprice) applies it to the linked loans once the
 * date arrives. One value per (basis, effectiveDate): a second answers 409.
 */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  if (!canDo(guard.user.role, "decide_asset_finance")) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 })
  }

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const body: unknown = await req.json().catch(() => null)
    const input = parseReferenceRateInput(body)
    if ("errors" in input) return NextResponse.json({ error: "Invalid reference rate", fields: input.errors }, { status: 400 })

    try {
      const created = await prisma.$transaction(async (tx) => {
        const row = await tx.referenceRate.create({
          data: {
            tenantId: tenant.id,
            basis: input.basis,
            effectiveDate: dbDate(input.effectiveDate),
            rate: new Prisma.Decimal(input.rate),
            createdById: guard.user.id,
          },
        })
        await logAuditStrict({
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.REFERENCE_RATE_RECORDED,
          entity: "ReferenceRate",
          entityId: row.id,
          newValue: { basis: row.basis, effectiveDate: input.effectiveDate, rate: row.rate.toString() },
        }, tx)
        return row
      })
      return NextResponse.json(view(created), { status: 201 })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return NextResponse.json({ error: `A ${input.basis} rate effective ${input.effectiveDate} is already recorded` }, { status: 409 })
      }
      throw error
    }
  })
}

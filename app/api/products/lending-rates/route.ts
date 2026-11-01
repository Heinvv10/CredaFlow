import { Prisma } from "@prisma/client"
import { NextRequest, NextResponse } from "next/server"
import { referenceRateView } from "@/app/api/asset-finance/reference-rates/view"
import { dbDate } from "@/lib/asset-finance/dates"
import { parseReferenceRateInput } from "@/lib/asset-finance/reference-rate-input"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { requireApiRole } from "@/lib/auth-guards"
import { isNcaJurisdiction } from "@/lib/jurisdiction/active"
import { ensureActiveJurisdiction } from "@/lib/jurisdiction/load.server"
import { canDo } from "@/lib/permissions"
import { VARIABLE_RATE_BASES } from "@/lib/product-engine/types"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"

const notHere = () => NextResponse.json({ error: "Reference rates do not apply here: an NCA lender records them under its repo rate and asset-finance pages." }, { status: 404 })

/** The approved and pending values a non-NCA lender's variable rates follow, newest first. */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  await ensureActiveJurisdiction()
  if (isNcaJurisdiction()) return notHere()
  return withTenantContext(req, async (tenant) => {
    const rows = await prisma.referenceRate.findMany({ where: { tenantId: tenant.id, basis: { in: [...VARIABLE_RATE_BASES] } }, orderBy: [{ basis: "asc" }, { effectiveDate: "desc" }, { id: "asc" }], take: 200 })
    return NextResponse.json({ rates: rows.map(referenceRateView) })
  })
}

/** Records a value, PENDING: it counts only once a different user approves it (./[id]/decide). The nightly sweep then reprices loans on it. */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  await ensureActiveJurisdiction()
  if (isNcaJurisdiction()) return notHere()
  if (!canDo(guard.user.role, "manage_product_versions")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  return withTenantContext(req, async (tenant) => {
    const input = parseReferenceRateInput(await req.json().catch(() => null))
    if ("errors" in input) return NextResponse.json({ error: "Invalid reference rate", fields: input.errors }, { status: 400 })
    if (!(VARIABLE_RATE_BASES as readonly string[]).includes(input.basis)) return NextResponse.json({ error: "Invalid reference rate", fields: { basis: `must be one of ${VARIABLE_RATE_BASES.join(", ")}` } }, { status: 400 })
    try {
      const created = await prisma.$transaction(async (tx) => {
        const row = await tx.referenceRate.create({ data: { tenantId: tenant.id, basis: input.basis, effectiveDate: dbDate(input.effectiveDate), rate: new Prisma.Decimal(input.rate), requestedById: guard.user.id } })
        await logAuditStrict({ tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email, action: AuditAction.REFERENCE_RATE_RECORDED, entity: "ReferenceRate", entityId: row.id, newValue: { basis: row.basis, effectiveDate: input.effectiveDate, rate: row.rate.toString(), status: row.status } }, tx)
        return row
      })
      return NextResponse.json(referenceRateView(created), { status: 201 })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return NextResponse.json({ error: `A ${input.basis} rate effective ${input.effectiveDate} is already recorded` }, { status: 409 })
      throw error
    }
  })
}

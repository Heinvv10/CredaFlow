import { NextRequest, NextResponse } from "next/server"
import { ncaOnlyRefusal } from "@/lib/jurisdiction/nca-only"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { requireApiRole } from "@/lib/auth-guards"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { dbDate } from "@/lib/asset-finance/dates"
import { parseReferenceRateInput } from "@/lib/asset-finance/reference-rate-input"
import { referenceRateAccess, visibleReferenceBases } from "@/lib/asset-finance/reference-rate-access"
import { REFERENCE_RATES_PAGE_LIMIT, referenceRateView } from "./view"

function pageOf(req: NextRequest): { limit: number; offset: number } | null {
  const params = req.nextUrl.searchParams
  const limit = Number(params.get("limit") ?? REFERENCE_RATES_PAGE_LIMIT)
  const offset = Number(params.get("offset") ?? 0)
  if (!Number.isInteger(limit) || limit < 1 || limit > REFERENCE_RATES_PAGE_LIMIT) return null
  if (!Number.isInteger(offset) || offset < 0) return null
  return { limit, offset }
}

/**
 * The tenant's reference-rate history, every status, by basis then newest
 * first. Paginated: `?limit=` (1-200, default 200) and `?offset=`;
 * `nextOffset` is null on the last page.
 */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  const notNca = ncaOnlyRefusal("Reference rates")
  if (notNca) return notNca

  return withTenantContext(req, async (tenant) => {
    // Without asset finance a tenant still keeps its repo rate (the NCA cap).
    const bases = await visibleReferenceBases(tenant.id)
    const page = pageOf(req)
    if (!page) return NextResponse.json({ error: `limit must be 1-${REFERENCE_RATES_PAGE_LIMIT} and offset >= 0` }, { status: 400 })
    const rows = await prisma.referenceRate.findMany({
      where: { tenantId: tenant.id, ...(bases ? { basis: { in: bases } } : {}) },
      orderBy: [{ basis: "asc" }, { effectiveDate: "desc" }, { id: "asc" }],
      skip: page.offset,
      take: page.limit + 1,
    })
    const more = rows.length > page.limit
    return NextResponse.json({
      rates: rows.slice(0, page.limit).map(referenceRateView),
      nextOffset: more ? page.offset + page.limit : null,
    })
  })
}

/**
 * Records a reference-rate value from its effective date, PENDING: it applies
 * only once a different user with decide_asset_finance approves it
 * (./[id]/decide). The repricing cron (app/api/cron/asset-finance-reprice)
 * then applies it to the linked loans once the date arrives. One live value
 * per (basis, effectiveDate): a second answers 409 (a REJECTED one does not
 * count). A caller without decide_asset_finance gets an audited 403.
 */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  const notNca = ncaOnlyRefusal("Reference rates")
  if (notNca) return notNca

  return withTenantContext(req, async (tenant) => {
    const body: unknown = await req.json().catch(() => null)
    const basis = typeof body === "object" && body !== null && (body as { basis?: unknown }).basis === "REPO" ? "REPO" : "PRIME"
    // REPO: manage_repo_rate, any tenant. Others: asset finance on + decide_asset_finance.
    const access = await referenceRateAccess(tenant.id, basis, guard.user.role)
    if (!access.ok) {
      if (access.reason) {
        await auditRefusal({
          action: AuditAction.REFERENCE_RATE_REFUSED,
          entity: "ReferenceRate",
          entityId: "new",
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          reason: access.reason,
          status: 403,
        })
      }
      return access.response
    }
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
            requestedById: guard.user.id,
          },
        })
        await logAuditStrict({
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.REFERENCE_RATE_RECORDED,
          entity: "ReferenceRate",
          entityId: row.id,
          newValue: { basis: row.basis, effectiveDate: input.effectiveDate, rate: row.rate.toString(), status: row.status },
        }, tx)
        return row
      })
      return NextResponse.json(referenceRateView(created), { status: 201 })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return NextResponse.json({ error: `A ${input.basis} rate effective ${input.effectiveDate} is already recorded` }, { status: 409 })
      }
      throw error
    }
  })
}

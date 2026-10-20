import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { parseBusinessEntityInput } from "@/lib/asset-finance/entity-input"
import { loadEntityCore } from "@/lib/asset-finance/entity-detail"
import { createBusinessEntity } from "@/lib/asset-finance/entity-create"

/** The tenant's business entities, newest first. */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const rows = await prisma.businessEntity.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        type: true,
        legalName: true,
        tradingName: true,
        registrationNumber: true,
        createdAt: true,
        _count: { select: { relationships: { where: { active: true } }, documents: { where: { deletedAt: null } } } },
      },
    })
    return NextResponse.json(
      rows.map(({ _count, createdAt, ...row }) => ({
        ...row,
        createdAt: createdAt.toISOString(),
        activePeople: _count.relationships,
        documents: _count.documents,
      })),
    )
  })
}

/** Create a business entity (manage_asset_finance). */
export async function POST(req: NextRequest) {
  // manage_asset_finance
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const body: unknown = await req.json().catch(() => null)
    const input = parseBusinessEntityInput(body)
    if ("errors" in input) return NextResponse.json({ error: "Invalid entity", fields: input.errors }, { status: 400 })

    const created = await createBusinessEntity(
      { kind: "staff", tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email },
      input.data,
    )
    if (created.kind === "duplicate") {
      return NextResponse.json(
        { error: `A ${input.data.type} with registration number ${input.data.registrationNumber} already exists` },
        { status: 409 },
      )
    }
    return NextResponse.json(await loadEntityCore(tenant.id, created.id), { status: 201 })
  })
}

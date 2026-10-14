import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { financialsChanged, parseBusinessEntityInput } from "@/lib/asset-finance/entity-input"
import {
  loadEntityCore,
  loadEntityDocuments,
  loadEntityPeople,
  loadEntityRecords,
} from "@/lib/asset-finance/entity-detail"
import { lockBusinessEntity } from "@/lib/asset-finance/entity-documents"
import { nullableFigureFromDb } from "@/lib/asset-finance/big-cents"
import { signedEntityChanges } from "@/lib/asset-finance/entity-freeze"

type Params = { params: Promise<{ id: string }> }

/** One entity with its people, documents and (read-only) applications, deals and loans. */
export async function GET(req: NextRequest, { params }: Params) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id } = await params
    const entity = await loadEntityCore(tenant.id, id)
    if (!entity) return NextResponse.json({ error: "Entity not found" }, { status: 404 })
    const [people, documents, records] = await Promise.all([
      loadEntityPeople(tenant.id, id),
      loadEntityDocuments(tenant.id, id),
      loadEntityRecords(tenant.id, id),
    ])
    return NextResponse.json({ entity, people, documents, ...records })
  })
}

/**
 * Replace the entity's details (the full body, as for create). The type is
 * fixed once created. Changing turnover, asset value or the financial year
 * clears financialsEvidenceIds: the documents attested the old figures.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  // manage_asset_finance
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id } = await params
    const body: unknown = await req.json().catch(() => null)
    const input = parseBusinessEntityInput(body)
    if ("errors" in input) return NextResponse.json({ error: "Invalid entity", fields: input.errors }, { status: 400 })

    try {
      const outcome = await prisma.$transaction(async (tx) => {
        if (!(await lockBusinessEntity(tx, tenant.id, id))) return "not_found" as const
        const row = await tx.businessEntity.findFirst({ where: { id, tenantId: tenant.id } })
        if (!row) return "not_found" as const
        const before = {
          ...row,
          annualTurnover: nullableFigureFromDb(row.annualTurnover),
          totalAssetValue: nullableFigureFromDb(row.totalAssetValue),
        }
        if (before.type !== input.data.type) return "type_changed" as const
        const identityChanges = signedEntityChanges(before, input.data)
        if (identityChanges.length > 0 && await tx.assetFinanceDeal.count({
          where: {
            tenantId: tenant.id,
            entityId: id,
            OR: [
              { status: { in: ["CONTRACTED", "BOOKED"] } },
              { status: "APPROVED", preparedSigners: { not: Prisma.DbNull } },
            ],
          },
        }) > 0) {
          return { kind: "identity_frozen" as const, fields: identityChanges }
        }
        const clearEvidence = financialsChanged(before, input.data) && before.financialsEvidenceIds.length > 0
        await tx.businessEntity.update({
          where: { id, tenantId: tenant.id },
          data: { ...input.data, ...(clearEvidence ? { financialsEvidenceIds: [] } : {}) },
        })
        await logAuditStrict(
          {
            tenantId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            action: AuditAction.BUSINESS_ENTITY_UPDATED,
            entity: "BusinessEntity",
            entityId: id,
            oldValue: {
              legalName: before.legalName,
              registrationNumber: before.registrationNumber,
              annualTurnover: before.annualTurnover,
              totalAssetValue: before.totalAssetValue,
              financialYearEnd: before.financialYearEnd?.toISOString().slice(0, 10) ?? null,
              financialsEvidenceIds: before.financialsEvidenceIds,
            },
            newValue: {
              legalName: input.data.legalName,
              registrationNumber: input.data.registrationNumber,
              annualTurnover: input.data.annualTurnover,
              totalAssetValue: input.data.totalAssetValue,
              financialYearEnd: input.data.financialYearEnd?.toISOString().slice(0, 10) ?? null,
              financialsEvidenceIds: clearEvidence ? [] : before.financialsEvidenceIds,
            },
          },
          tx,
        )
        return "updated" as const
      })
      if (outcome === "not_found") return NextResponse.json({ error: "Entity not found" }, { status: 404 })
      if (outcome === "type_changed") {
        return NextResponse.json(
          { error: "An entity's type cannot change; create a new entity", fields: { type: "Fixed once created" } },
          { status: 400 },
        )
      }
      if (typeof outcome === "object" && outcome.kind === "identity_frozen") {
        await auditRefusal({
          action: AuditAction.BUSINESS_ENTITY_UPDATE_REFUSED,
          entity: "BusinessEntity",
          entityId: id,
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          reason: "signed_identity_frozen",
          status: 409,
          detail: { fields: outcome.fields },
        })
        return NextResponse.json(
          { error: `The entity has prepared or contracted documents; signed identity fields can no longer change: ${outcome.fields.join(", ")}` },
          { status: 409 },
        )
      }
      return NextResponse.json(await loadEntityCore(tenant.id, id))
    } catch (error) {
      if (isCheckViolation(error)) {
        await auditRefusal({
          action: AuditAction.BUSINESS_ENTITY_UPDATE_REFUSED,
          entity: "BusinessEntity",
          entityId: id,
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          reason: "signed_identity_frozen",
          status: 409,
        })
        return NextResponse.json({ error: "The database refused the edit because the entity has an approved deal" }, { status: 409 })
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return NextResponse.json(
          { error: `A ${input.data.type} with registration number ${input.data.registrationNumber} already exists` },
          { status: 409 },
        )
      }
      throw error
    }
  })
}

import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { FINANCIALS_EVIDENCE_TYPES, invalidFinancialsEvidenceIds, lockBusinessEntity } from "@/lib/asset-finance/entity-documents"
import { loadEntityCore } from "@/lib/asset-finance/entity-detail"

type Params = { params: Promise<{ id: string }> }

const MAX_EVIDENCE_IDS = 20

function parseDocumentIds(body: unknown): string[] | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null
  const value = (body as { documentIds?: unknown }).documentIds
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_IDS) return null
  const ids: string[] = []
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") return null
    ids.push(item.trim())
  }
  return [...new Set(ids)]
}

/**
 * Set the documents that evidence the entity's turnover / asset value — the
 * NCA classifier's financials evidence (DESIGN D5). Every id must name one of
 * THIS entity's verified, live AFS or management-accounts documents; anything
 * else answers 400 and nothing is written. An empty list clears the evidence.
 *
 * Body: { documentIds: string[] }
 */
export async function PUT(req: NextRequest, { params }: Params) {
  // manage_asset_finance
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id } = await params
    const documentIds = parseDocumentIds(await req.json().catch(() => null))
    if (!documentIds) {
      return NextResponse.json(
        { error: `documentIds must be an array of at most ${MAX_EVIDENCE_IDS} document ids` },
        { status: 400 },
      )
    }

    const outcome = await prisma.$transaction(async (tx) => {
      if (!(await lockBusinessEntity(tx, tenant.id, id))) return { kind: "not_found" as const }
      const entity = await tx.businessEntity.findFirst({
        where: { id, tenantId: tenant.id },
        select: { id: true, financialsEvidenceIds: true, annualTurnover: true, totalAssetValue: true },
      })
      if (!entity) return { kind: "not_found" as const }
      if (documentIds.length > 0 && entity.annualTurnover === null && entity.totalAssetValue === null) {
        return { kind: "no_figures" as const }
      }
      const invalid = await invalidFinancialsEvidenceIds(tx, tenant.id, id, documentIds)
      if (invalid.length > 0) return { kind: "invalid" as const, invalid }
      await tx.businessEntity.update({ where: { id, tenantId: tenant.id }, data: { financialsEvidenceIds: documentIds } })
      await logAuditStrict(
        {
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.ENTITY_FINANCIALS_EVIDENCE_SET,
          entity: "BusinessEntity",
          entityId: id,
          oldValue: { financialsEvidenceIds: entity.financialsEvidenceIds },
          newValue: {
            financialsEvidenceIds: documentIds,
            annualTurnover: entity.annualTurnover,
            totalAssetValue: entity.totalAssetValue,
          },
        },
        tx,
      )
      return { kind: "set" as const }
    })

    switch (outcome.kind) {
      case "not_found":
        return NextResponse.json({ error: "Entity not found" }, { status: 404 })
      case "no_figures":
        return NextResponse.json(
          { error: "Record the turnover or asset value and its financial year before attaching evidence" },
          { status: 400 },
        )
      case "invalid":
        return NextResponse.json(
          {
            error: `Evidence must be this entity's verified ${FINANCIALS_EVIDENCE_TYPES.join(" or ")} documents`,
            invalidDocumentIds: outcome.invalid,
          },
          { status: 400 },
        )
      case "set":
        return NextResponse.json(await loadEntityCore(tenant.id, id))
    }
  })
}

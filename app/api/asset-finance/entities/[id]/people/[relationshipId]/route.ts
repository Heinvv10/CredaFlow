import { NextRequest, NextResponse } from "next/server"
import type { EntityRole } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { loadEntityPeople } from "@/lib/asset-finance/entity-detail"

type Params = { params: Promise<{ id: string; relationshipId: string }> }

const FIXED_ON_OPEN_DEAL: readonly EntityRole[] = ["SURETY", "AUTHORISED_SIGNATORY", "DIRECTOR", "TRUSTEE"]

/**
 * Deactivate one role of a person in the entity. The row is kept (history,
 * audit, past classifications); `active = false` removes the authority, so a
 * deactivated director loses portal access at once.
 *
 * While the entity has an APPROVED or CONTRACTED deal its sureties and
 * signatories (SURETY, AUTHORISED_SIGNATORY, DIRECTOR, TRUSTEE) are the ones
 * the deal's documents were prepared for: deactivating one is refused (409,
 * audited) until the deal is booked or cancelled. The database refuses the
 * same (guardEntityRelationshipOnOpenDeal).
 */
export async function DELETE(req: NextRequest, { params }: Params) {
  // manage_asset_finance
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id, relationshipId } = await params

    const run = () => prisma.$transaction(async (tx) => {
      const row = await tx.entityRelationship.findFirst({
        where: { id: relationshipId, entityId: id, tenantId: tenant.id },
        select: { id: true, clientId: true, role: true, active: true },
      })
      if (!row) return "not_found" as const
      if (!row.active) return "unchanged" as const
      if (FIXED_ON_OPEN_DEAL.includes(row.role)) {
        const open = await tx.assetFinanceDeal.findFirst({
          where: { tenantId: tenant.id, entityId: id, status: { in: ["APPROVED", "CONTRACTED"] } },
          select: { id: true },
        })
        if (open) return "deal_open" as const
      }
      // Pinned on active: a concurrent deactivation writes once, audits once.
      const { count } = await tx.entityRelationship.updateMany({
        where: { id: row.id, tenantId: tenant.id, active: true },
        data: { active: false },
      })
      if (count === 0) return "unchanged" as const
      await logAuditStrict(
        {
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.ENTITY_RELATIONSHIP_DEACTIVATED,
          entity: "EntityRelationship",
          entityId: row.id,
          oldValue: { active: true },
          newValue: { businessEntityId: id, clientId: row.clientId, role: row.role, active: false },
        },
        tx,
      )
      return "deactivated" as const
    })
    let outcome: Awaited<ReturnType<typeof run>>
    try {
      outcome = await run()
    } catch (error) {
      if (!isCheckViolation(error)) throw error
      outcome = "deal_open"
    }
    if (outcome === "not_found") return NextResponse.json({ error: "Relationship not found" }, { status: 404 })
    if (outcome === "deal_open") {
      await auditRefusal({
        action: AuditAction.ENTITY_RELATIONSHIP_CHANGE_REFUSED,
        entity: "EntityRelationship",
        entityId: relationshipId,
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        reason: "deal_open",
        status: 409,
      })
      return NextResponse.json(
        { error: "The entity has an approved deal: its sureties and signatories are fixed until the deal is booked or cancelled" },
        { status: 409 },
      )
    }
    return NextResponse.json(await loadEntityPeople(tenant.id, id))
  })
}

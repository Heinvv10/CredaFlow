import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { loadEntityPeople } from "@/lib/asset-finance/entity-detail"

type Params = { params: Promise<{ id: string; relationshipId: string }> }

/**
 * Deactivate one role of a person in the entity. The row is kept (history,
 * audit, past classifications); `active = false` removes the authority, so a
 * deactivated director loses portal access at once.
 */
export async function DELETE(req: NextRequest, { params }: Params) {
  // manage_asset_finance
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id, relationshipId } = await params

    const outcome = await prisma.$transaction(async (tx) => {
      const row = await tx.entityRelationship.findFirst({
        where: { id: relationshipId, entityId: id, tenantId: tenant.id },
        select: { id: true, clientId: true, role: true, active: true },
      })
      if (!row) return "not_found" as const
      if (!row.active) return "unchanged" as const
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
    if (outcome === "not_found") return NextResponse.json({ error: "Relationship not found" }, { status: 404 })
    return NextResponse.json(await loadEntityPeople(tenant.id, id))
  })
}

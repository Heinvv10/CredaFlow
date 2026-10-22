import { NextRequest, NextResponse } from "next/server"
import { Prisma, type EntityRole } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { parseRelationshipInput, relationshipRowValues } from "@/lib/asset-finance/relationship-input"
import { loadEntityPeople } from "@/lib/asset-finance/entity-detail"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { ERASED_PARTY } from "@/lib/dealer/draft-purge-messages"

type Params = { params: Promise<{ id: string }> }

class RoleConflict extends Error {
  constructor(readonly roles: EntityRole[]) {
    super("roles already active")
  }
}

/**
 * Link an existing Client to the entity in one or more roles — one
 * EntityRelationship row per role. A new person is first created through the
 * existing client-creation path (POST /api/clients, the client wizard) and
 * then linked here by id. A role the person held before and lost is
 * reactivated; a role they hold now answers 409.
 *
 * Body: { clientId, roles: EntityRole[], trusteeKind?, ownershipPct? }
 */
export async function POST(req: NextRequest, { params }: Params) {
  // manage_asset_finance
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id } = await params
    const entity = await prisma.businessEntity.findFirst({ where: { id, tenantId: tenant.id }, select: { id: true, type: true } })
    if (!entity) return NextResponse.json({ error: "Entity not found" }, { status: 404 })

    const body: unknown = await req.json().catch(() => null)
    const input = parseRelationshipInput(body, entity.type)
    if ("errors" in input) return NextResponse.json({ error: "Invalid relationship", fields: input.errors }, { status: 400 })

    const client = await prisma.client.findFirst({
      where: { id: input.data.clientId, tenantId: tenant.id },
      select: { id: true, reference: true },
    })
    if (!client) return NextResponse.json({ error: "Client not found", fields: { clientId: "No such client" } }, { status: 400 })

    try {
      await prisma.$transaction(async (tx) => {
        const existing = await tx.entityRelationship.findMany({
          where: { tenantId: tenant.id, entityId: id, clientId: client.id, role: { in: input.data.roles } },
          select: { id: true, role: true, active: true },
        })
        const active = existing.filter((r) => r.active).map((r) => r.role)
        if (active.length > 0) throw new RoleConflict(active)

        for (const role of input.data.roles) {
          const values = relationshipRowValues(input.data, role)
          const prior = existing.find((r) => r.role === role)
          const row = prior
            ? await tx.entityRelationship.update({
                where: { id: prior.id, tenantId: tenant.id },
                data: { ...values, active: true },
                select: { id: true },
              })
            : await tx.entityRelationship.create({
                data: { tenantId: tenant.id, entityId: id, clientId: client.id, role, ...values },
                select: { id: true },
              })
          await logAuditStrict(
            {
              tenantId: tenant.id,
              userId: guard.user.id,
              userEmail: guard.user.email,
              action: AuditAction.ENTITY_RELATIONSHIP_ADDED,
              entity: "EntityRelationship",
              entityId: row.id,
              newValue: {
                businessEntityId: id,
                clientId: client.id,
                clientReference: client.reference,
                role,
                ...values,
                reactivated: prior !== undefined,
              },
            },
            tx,
          )
        }
      })
    } catch (error) {
      if (error instanceof RoleConflict) {
        return NextResponse.json({ error: `Already active as ${error.roles.join(", ")}` }, { status: 409 })
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return NextResponse.json({ error: "That role was just added by someone else" }, { status: 409 })
      }
      // guardDealerPurgedPartyUse: the dealer draft purge erased this person or business.
      if (isCheckViolation(error) && error instanceof Error && error.message.includes(ERASED_PARTY)) {
        return NextResponse.json({ error: "This person or business was erased by the dealer draft purge: capture them again" }, { status: 409 })
      }
      // EntityRelationship_fixed_on_open_deal: no party is added or reactivated while a deal is approved.
      if (isCheckViolation(error)) {
        return NextResponse.json(
          { error: "The entity has an approved deal: no party is added or reactivated until the deal is booked or cancelled" },
          { status: 409 },
        )
      }
      throw error
    }
    return NextResponse.json(await loadEntityPeople(tenant.id, id), { status: 201 })
  })
}

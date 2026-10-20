/**
 * Create a business entity with its audit row in one transaction: the staff
 * route (POST /api/asset-finance/entities) and the dealer portal
 * (lib/dealer/capture.ts) both come here. A dealer's entity carries
 * createdByDealerId. The registration number is unique per lender and type:
 * a duplicate is reported, never shown.
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { BusinessEntityInput } from "./entity-input"
import { originationAudit, originationColumns, originationTenant, type OriginationActor } from "./origination-actor"

export type CreateEntityResult = { kind: "created"; id: string } | { kind: "duplicate" }

export async function createBusinessEntity(by: OriginationActor, input: BusinessEntityInput): Promise<CreateEntityResult> {
  const tenantId = originationTenant(by)
  const audit = originationAudit(by)
  try {
    const id = await prisma.$transaction(async (tx) => {
      const created = await tx.businessEntity.create({
        data: { tenantId, ...input, ...originationColumns(by) },
        select: { id: true },
      })
      await logAuditStrict(
        {
          tenantId,
          userId: audit.userId,
          userEmail: audit.userEmail,
          action: AuditAction.BUSINESS_ENTITY_CREATED,
          entity: "BusinessEntity",
          entityId: created.id,
          newValue: {
            type: input.type,
            legalName: input.legalName,
            registrationNumber: input.registrationNumber,
            annualTurnover: input.annualTurnover,
            totalAssetValue: input.totalAssetValue,
            financialYearEnd: input.financialYearEnd?.toISOString().slice(0, 10) ?? null,
            ...(audit.actor ? { actor: audit.actor } : {}),
          },
        },
        tx,
      )
      return created.id
    })
    return { kind: "created", id }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { kind: "duplicate" }
    throw error
  }
}

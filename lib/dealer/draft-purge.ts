/**
 * The dealer draft purge (cron asset-finance-dealer-draft-purge, daily;
 * docs/asset-finance/SLICE5-FOLLOWUPS.md part D, POPIA s14). Which deal may be
 * purged, and why, is the database's one definition, "dealerDealPurgeReason":
 * never a deal with a loan; a deal the lender never received 90 days after its
 * last activity or its cancellation; a handed-over deal that ended DECLINED,
 * REFUSED_NCA or CANCELLED three years after it ended (NCA Regulation 55).
 *
 * Per deal, in its own transaction with the deal locked:
 *   1. the tombstone (DealerDealPurge: reason and counts; its trigger re-checks
 *      the reason);
 *   2. each dealer-captured person and the business, unless linked to anything
 *      beyond this deal ("dealerPurgeLinkedElsewhere", read from the catalog):
 *      setting dealerPurgedAt makes the database erase the row in place
 *      (guardDealerPurgedParty). Rows other tables refer to (the deal, the
 *      consent attestations) are anonymised, never deleted;
 *   3. each document of the deal: its bytes deleted from storage, then the row
 *      deleted when nothing refers to it, else kept soft-deleted as "erased";
 *   4. one DEALER_DEAL_PURGED audit row, counts only.
 * The deal, its application and every audit row stay. Idempotent: a deal with
 * a tombstone is never selected again.
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { deleteManagedFileStrict } from "@/lib/storage"
import { lockDeal } from "@/lib/asset-finance/signing-prepare"

const MAX_DEALS_PER_TENANT = 500
export const ERASED_FILE_NAME = "erased"

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

export interface DealerDraftPurgeRun {
  ok: boolean
  tenants: number
  deals: number
  failed: number
}

export interface DealerDealPurgeCounts {
  clientsErased: number
  clientsKept: number
  entitiesErased: number
  entitiesKept: number
  documentsErased: number
}

async function linkedElsewhere(tx: Tx, tenantId: string, table: "Client" | "BusinessEntity", id: string, dealId: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<Array<{ linked: boolean }>>(Prisma.sql`
    SELECT "dealerPurgeLinkedElsewhere"(${tenantId}, ${table}, ${id}, ${dealId}) AS "linked"`)
  return row.linked
}

async function documentReferenced(tx: Tx, id: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<Array<{ referenced: boolean }>>(Prisma.sql`
    SELECT "dealerPurgeRowReferenced"('EntityDocument', ${id}) AS "referenced"`)
  return row.referenced
}

/** Purge one deal; null when the database no longer names it (a race, or it was purged meanwhile). */
export async function purgeDealerDeal(tenantId: string, dealId: string): Promise<DealerDealPurgeCounts | null> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockDeal(tx, tenantId, dealId))) return null
    const [{ reason }] = await tx.$queryRaw<Array<{ reason: string | null }>>(Prisma.sql`
      SELECT "dealerDealPurgeReason"(${tenantId}, ${dealId})::text AS "reason"`)
    const done = await tx.dealerDealPurge.findFirst({ where: { tenantId, dealId }, select: { id: true } })
    if (!reason || done) return null
    const deal = await tx.assetFinanceDeal.findFirstOrThrow({
      where: { id: dealId, tenantId }, select: { clientId: true, entityId: true, dealerId: true },
    })
    const personIds = deal.clientId ? [deal.clientId] : (await tx.entityRelationship.findMany({
      where: { tenantId, entityId: deal.entityId ?? undefined }, select: { clientId: true },
    })).map((r) => r.clientId)
    const people = await tx.client.findMany({
      where: { tenantId, id: { in: [...new Set(personIds)] }, dealerPurgedAt: null }, select: { id: true, createdByDealerId: true },
    })
    const erasePeople: string[] = []
    for (const person of people) {
      if (person.createdByDealerId === deal.dealerId && !(await linkedElsewhere(tx, tenantId, "Client", person.id, dealId))) erasePeople.push(person.id)
    }
    const entity = deal.entityId
      ? await tx.businessEntity.findFirst({ where: { id: deal.entityId, tenantId, dealerPurgedAt: null }, select: { id: true, createdByDealerId: true } })
      : null
    const eraseEntity = entity !== null && entity.createdByDealerId === deal.dealerId
      && !(await linkedElsewhere(tx, tenantId, "BusinessEntity", entity.id, dealId))
    const documents = await tx.entityDocument.findMany({ where: { tenantId, dealId }, select: { id: true, storagePath: true, deletedAt: true } })

    const counts: DealerDealPurgeCounts = {
      clientsErased: erasePeople.length, clientsKept: people.length - erasePeople.length,
      entitiesErased: eraseEntity ? 1 : 0, entitiesKept: entity && !eraseEntity ? 1 : 0, documentsErased: documents.length,
    }
    const now = new Date()
    await tx.dealerDealPurge.create({ data: { tenantId, dealId, reason: reason as never, purgedAt: now, ...counts } })
    if (erasePeople.length > 0) await tx.client.updateMany({ where: { tenantId, id: { in: erasePeople } }, data: { dealerPurgedAt: now } })
    if (eraseEntity && entity) await tx.businessEntity.updateMany({ where: { tenantId, id: entity.id }, data: { dealerPurgedAt: now } })
    for (const document of documents) {
      await deleteManagedFileStrict(document.storagePath)
      if (await documentReferenced(tx, document.id)) {
        await tx.entityDocument.update({
          where: { id: document.id, tenantId },
          data: { fileName: ERASED_FILE_NAME, ...(document.deletedAt ? {} : { deletedAt: now, deletedById: "system:dealer-draft-purge" }) },
        })
      } else {
        await tx.entityDocument.delete({ where: { id: document.id, tenantId } })
      }
    }
    await logAuditStrict({
      tenantId, action: AuditAction.DEALER_DEAL_PURGED, entity: "AssetFinanceDeal", entityId: dealId,
      newValue: { reason, ...counts, actor: { type: "system", source: "dealer-draft-purge" } },
    }, tx)
    return counts
  }, { timeout: 60_000 })
}

/** One lender's eligible deals, oldest first (at most MAX_DEALS_PER_TENANT a run). */
export async function purgeDealerDraftsOfTenant(tenantId: string): Promise<{ deals: number; failed: number }> {
  const candidates = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT d."id" FROM "AssetFinanceDeal" d
    WHERE d."tenantId" = ${tenantId} AND d."dealerId" IS NOT NULL AND d."loanId" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "DealerDealPurge" p WHERE p."tenantId" = d."tenantId" AND p."dealId" = d."id")
      AND "dealerDealPurgeReason"(d."tenantId", d."id") IS NOT NULL
    ORDER BY d."createdAt", d."id"
    LIMIT ${MAX_DEALS_PER_TENANT}`)
  let deals = 0
  let failed = 0
  for (const { id } of candidates) {
    try {
      if (await purgeDealerDeal(tenantId, id)) deals++
    } catch (error) {
      failed++
      console.error("[dealer-draft-purge] deal failed", { tenantId, dealId: id, error: error instanceof Error ? error.message : "unknown" })
    }
  }
  return { deals, failed }
}

export async function purgeDealerDrafts(): Promise<DealerDraftPurgeRun> {
  const run: DealerDraftPurgeRun = { ok: true, tenants: 0, deals: 0, failed: 0 }
  // Every lender with a dealer, whatever its portal flag today: retention outlives a switched-off portal.
  const tenants = await prisma.tenantConfig.findMany({
    where: { tenant: { dealers: { some: {} } } }, orderBy: { tenantId: "asc" }, select: { tenantId: true },
  })
  for (const { tenantId } of tenants) {
    run.tenants++
    try {
      const purged = await runWithTenant(tenantId, () => purgeDealerDraftsOfTenant(tenantId))
      run.deals += purged.deals
      run.failed += purged.failed
    } catch (error) {
      run.failed++
      console.error("[dealer-draft-purge] tenant failed", { tenantId, error: error instanceof Error ? error.message : "unknown" })
    }
  }
  run.ok = run.failed === 0
  return run
}

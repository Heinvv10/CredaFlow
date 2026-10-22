/**
 * The dealer draft purge (cron asset-finance-dealer-draft-purge, daily;
 * docs/asset-finance/SLICE5-FOLLOWUPS.md part D, POPIA s14). Which deal may be
 * purged, and why, is the database's one definition, "dealerDealPurgeReason":
 * only a dealer deal the lender never received, with no loan and no open DSAR
 * or complaint on its people, 90 days after its last activity (DRAFT) or its
 * cancellation. A deal handed to the lender is never purged here.
 *
 * Per deal, in its own transaction with the deal and its parties locked:
 *   1. which dealer-captured people and business are linked to nothing else
 *      ("dealerPurgeLinkedElsewhere": every foreign key and the listed text
 *      links; another stale draft on the same party is not a link), and which
 *      documents go with them (only a document whose party is erased or that
 *      names none, and that no kept business cites);
 *   2. the tombstone (DealerDealPurge: reason and counts; its trigger re-checks
 *      the reason), then dealerPurgedAt on each erasable party: the database
 *      overwrites the row in place (guardDealerPurgedParty);
 *   3. each erasable document row: deleted when nothing refers to it, else kept
 *      soft-deleted as "erased";
 *   4. one DEALER_DEAL_PURGED audit row, counts only.
 * After the commit, the erased documents' bytes are deleted from storage; the
 * paths are recorded in the same transaction (DealerPurgePendingFile) and the
 * record goes only with the file, so a crash in between is drained next run.
 * The deal, its application and every audit row stay. Idempotent: a deal with
 * a tombstone is never selected again, and the database closes it
 * (guardPurgedDealerDeal).
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
  documentsKept: number
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

/** Whether a business that stays cites the document as its financials evidence (a text array, no foreign key). */
async function citedAsEvidence(tx: Tx, tenantId: string, id: string, erasedEntityId: string | null): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "BusinessEntity" WHERE "tenantId" = ${tenantId} AND ${id} = ANY("financialsEvidenceIds")
      AND "id" IS DISTINCT FROM ${erasedEntityId} LIMIT 1`)
  return rows.length > 0
}

type Planned = { counts: DealerDealPurgeCounts; pendingIds: string[] }

async function purgeInTransaction(tenantId: string, dealId: string): Promise<Planned | null> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockDeal(tx, tenantId, dealId))) return null
    const [{ reason }] = await tx.$queryRaw<Array<{ reason: string | null }>>(Prisma.sql`
      SELECT "dealerDealPurgeReason"(${tenantId}, ${dealId})::text AS "reason"`)
    const done = await tx.dealerDealPurge.findFirst({ where: { tenantId, dealId }, select: { id: true } })
    if (!reason || done) return null
    const deal = await tx.assetFinanceDeal.findFirstOrThrow({
      where: { id: dealId, tenantId }, select: { clientId: true, entityId: true, dealerId: true },
    })
    // Lock order, as every deal path takes them: deals first (the sibling drafts that could stop
    // keeping these parties; never a booked or handed-over deal), then the business, then its people.
    // A link or a sibling's activity another transaction adds meanwhile waits, or is seen below.
    const readPeople = async () => [...new Set(deal.clientId ? [deal.clientId] : deal.entityId ? (await tx.entityRelationship.findMany({
      where: { tenantId, entityId: deal.entityId }, select: { clientId: true },
    })).map((r) => r.clientId) : [])]
    const firstRead = await readPeople()
    await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "AssetFinanceDeal" WHERE "tenantId" = ${tenantId} AND "loanId" IS NULL AND "dealerSubmittedAt" IS NULL
      AND ("entityId" = ${deal.entityId} OR "clientId" IN (${Prisma.join(firstRead.length > 0 ? firstRead : [""])})) FOR UPDATE`)
    if (deal.entityId) await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "BusinessEntity" WHERE "tenantId" = ${tenantId} AND "id" = ${deal.entityId} FOR UPDATE`)
    const personIds = await readPeople()
    if (personIds.length > 0) await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "Client" WHERE "tenantId" = ${tenantId} AND "id" IN (${Prisma.join(personIds)}) FOR UPDATE`)
    const allPeople = await tx.client.findMany({ where: { tenantId, id: { in: personIds } }, select: { id: true, createdByDealerId: true, dealerPurgedAt: true } })
    const people = allPeople.filter((p) => p.dealerPurgedAt === null)
    const erasePeople: string[] = []
    for (const person of people) {
      if (person.createdByDealerId === deal.dealerId && !(await linkedElsewhere(tx, tenantId, "Client", person.id, dealId))) erasePeople.push(person.id)
    }
    const anyEntity = deal.entityId
      ? await tx.businessEntity.findFirst({ where: { id: deal.entityId, tenantId }, select: { id: true, createdByDealerId: true, dealerPurgedAt: true } })
      : null
    const entity = anyEntity && anyEntity.dealerPurgedAt === null ? anyEntity : null
    const eraseEntity = entity !== null && entity.createdByDealerId === deal.dealerId
      && !(await linkedElsewhere(tx, tenantId, "BusinessEntity", entity.id, dealId))

    // A document goes only with its party, erased now or by an earlier purge (a sibling draft's): one about a
    // person or business that is kept stays, and so does any a kept business cites.
    const erasedEntityId = eraseEntity && entity ? entity.id : null
    const goneEntities = [...(erasedEntityId ? [erasedEntityId] : []), ...(anyEntity?.dealerPurgedAt ? [anyEntity.id] : [])]
    const gonePeople = [...erasePeople, ...allPeople.filter((p) => p.dealerPurgedAt !== null).map((p) => p.id)]
    const partyGone = (id: string | null, gone: string[]) => id === null || gone.includes(id)
    const documents = await tx.entityDocument.findMany({ where: { tenantId, dealId }, select: { id: true, storagePath: true, deletedAt: true, entityId: true, clientId: true } })
    const erasable: typeof documents = []
    for (const document of documents) {
      if (partyGone(document.entityId, goneEntities) && partyGone(document.clientId, gonePeople)
        && !(await citedAsEvidence(tx, tenantId, document.id, erasedEntityId))) erasable.push(document)
    }
    const counts: DealerDealPurgeCounts = {
      clientsErased: erasePeople.length, clientsKept: people.length - erasePeople.length,
      entitiesErased: eraseEntity ? 1 : 0, entitiesKept: entity && !eraseEntity ? 1 : 0,
      documentsErased: erasable.length, documentsKept: documents.length - erasable.length,
    }
    // The tombstone first: the database erases a party only for a purged deal naming it.
    const now = new Date()
    await tx.dealerDealPurge.create({ data: { tenantId, dealId, reason: reason as never, purgedAt: now, ...counts } })
    if (erasePeople.length > 0) await tx.client.updateMany({ where: { tenantId, id: { in: erasePeople } }, data: { dealerPurgedAt: now } })
    if (erasedEntityId) await tx.businessEntity.updateMany({ where: { tenantId, id: erasedEntityId }, data: { dealerPurgedAt: now } })
    // The files go after the commit; a record of each survives a crash in between (drainPendingFiles).
    const pending = await Promise.all(erasable.map((d) =>
      tx.dealerPurgePendingFile.create({ data: { tenantId, storagePath: d.storagePath }, select: { id: true } })))
    for (const document of erasable) {
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
    return { counts, pendingIds: pending.map((p) => p.id) }
  }, { timeout: 60_000 })
}

/**
 * Purge one deal; null when the database no longer names it (a race, or it was
 * purged meanwhile). The bytes go after the rows commit, so a refused write
 * never leaves a row without its file; a file that cannot be deleted is
 * reported (filesNotDeleted) and logged with its path for the operator.
 */
export async function purgeDealerDeal(tenantId: string, dealId: string): Promise<(DealerDealPurgeCounts & { filesNotDeleted: number }) | null> {
  const planned = await purgeInTransaction(tenantId, dealId)
  if (!planned) return null
  return { ...planned.counts, filesNotDeleted: await drainPendingFiles(tenantId, planned.pendingIds) }
}

/**
 * Deletes purged documents' files still recorded as pending (these ids, or
 * every one of the lender's: a run starts with those a crash or a failure
 * left), then their records. A file that cannot be deleted stays recorded
 * (and logged with its path) for the next run; the count of those is returned.
 */
export async function drainPendingFiles(tenantId: string, ids?: string[]): Promise<number> {
  const pending = await prisma.dealerPurgePendingFile.findMany({
    where: { tenantId, ...(ids ? { id: { in: ids } } : {}) }, orderBy: { createdAt: "asc" }, select: { id: true, storagePath: true },
  })
  let failed = 0
  for (const file of pending) {
    try {
      await deleteManagedFileStrict(file.storagePath)
      // deleteMany: an overlapping run may have drained it already.
      await prisma.dealerPurgePendingFile.deleteMany({ where: { id: file.id, tenantId } })
    } catch (error) {
      failed++
      console.error("[dealer-draft-purge] file not deleted", { tenantId, file: file.storagePath, error: error instanceof Error ? error.message : "unknown" })
    }
  }
  return failed
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
  let failed = (await drainPendingFiles(tenantId)) > 0 ? 1 : 0
  for (const { id } of candidates) {
    try {
      const purged = await purgeDealerDeal(tenantId, id)
      if (purged) deals++
      if (purged && purged.filesNotDeleted > 0) failed++
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

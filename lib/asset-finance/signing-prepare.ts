// Prepare an APPROVED deal's documents for signing (goal §4.9): render the
// agreement, the resolution and a suretyship per surety, store each PDF once
// in the same storage as entity documents (lib/storage), and create one
// DealSigner row per required signature binding those bytes by sha256.
//
// Unsigned documents are NOT EntityDocument rows: a SIGNED_* EntityDocument is
// only ever a wet-ink scan (./signing-wet-ink.ts), so a draft is never listed
// or mistaken for executed evidence. The signer row holds the bytes' path and
// digest; every read of them is logged against the signer row's id.
//
// Preparation also fixes the contract terms on the deal (review item 1): the
// planned start date staff chose (default today SAST; from today to 90 days
// ahead, before the first instalment), the instalment, rate and total interest of the schedule the
// agreement prints, the arrears terms copied from the product (null disables
// default interest), and
// the required signer set (preparedSigners). Booking reproduces and checks
// those figures; the contract gate counts signatures against that set.
//
// Idempotent while nothing is recorded: preparing again re-renders, re-binds
// the rows, drops rows no longer required and re-fixes the terms. Once any
// signature or scan is on record it is refused (guardDealSigner and
// guardAssetDealSignedTerms refuse it in the database).
import { Prisma, type AssetDealStatus, type DealDocumentKind } from "@prisma/client"
import { sastCalendarDate } from "@/lib/date/sast"
import { prisma } from "@/lib/prisma"
import { deleteFile, saveFile } from "@/lib/storage"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { loadDealDocumentData } from "./documents/deal-document-data"
import { renderDealDocument } from "./documents/render"
import { dbDate, fromDayNumber, isoOfDbDate, toDayNumber } from "./dates"
import { deriveRequiredSigners, preparedSignerSet, requiredFromPrepared, type RequiredSigner } from "./signing"

export type SigningTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

export interface SigningActor {
  tenantId: string
  userId: string
  userEmail?: string | null
}

export type PrepareResult =
  | { kind: "not_found" }
  | { kind: "not_approved"; status: AssetDealStatus }
  | { kind: "signing_started" }
  | { kind: "no_authority" }
  | { kind: "people_changed" }
  | { kind: "invalid_start"; error: string }
  | { kind: "prepared"; signers: number }

interface StoredDocument {
  sha256: string
  storagePath: string
}

const signerKey = (s: { clientId: string; document: DealDocumentKind }) => `${s.document}:${s.clientId}`
const documentKey = (s: { clientId: string; document: DealDocumentKind }) =>
  s.document === "SURETYSHIP" ? signerKey(s) : s.document

/** Lock the deal row for the transaction; null when it is not this tenant's. */
export async function lockDeal(
  tx: SigningTx,
  tenantId: string,
  dealId: string,
): Promise<{ status: AssetDealStatus; entityId: string | null; clientId: string | null } | null> {
  const rows = await tx.$queryRaw<Array<{ status: AssetDealStatus; entityId: string | null; clientId: string | null }>>(Prisma.sql`
    SELECT "status", "entityId", "clientId" FROM "AssetFinanceDeal"
    WHERE "id" = ${dealId} AND "tenantId" = ${tenantId}
    FOR UPDATE
  `)
  return rows[0] ?? null
}

/** The required set as it stands now, read inside the transaction. */
export async function currentRequiredSigners(
  tx: SigningTx,
  tenantId: string,
  entityId: string,
): Promise<RequiredSigner[]> {
  const entity = await tx.businessEntity.findFirstOrThrow({ where: { id: entityId, tenantId }, select: { type: true } })
  const relationships = await tx.entityRelationship.findMany({
    where: { tenantId, entityId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { clientId: true, role: true, active: true },
  })
  return deriveRequiredSigners(entity.type, relationships)
}

/**
 * The required set for a deal's borrower: an entity's people (as
 * currentRequiredSigners), or a sole-proprietor lessee alone, signing the
 * agreement (guardAssetDealSignedTerms requires exactly that row).
 */
export async function requiredBorrowerSigners(
  tx: SigningTx,
  tenantId: string,
  borrower: { entityId: string | null; clientId: string | null },
): Promise<RequiredSigner[]> {
  if (borrower.entityId !== null) return currentRequiredSigners(tx, tenantId, borrower.entityId)
  return borrower.clientId === null ? [] : [{ clientId: borrower.clientId, role: "AUTHORISED_SIGNATORY", document: "AGREEMENT" }]
}

/** The signer set a deal was prepared with (AssetFinanceDeal.preparedSigners); empty before preparation. */
export async function preparedRequiredSigners(tx: SigningTx, tenantId: string, dealId: string): Promise<RequiredSigner[]> {
  const deal = await tx.assetFinanceDeal.findFirstOrThrow({ where: { id: dealId, tenantId }, select: { preparedSigners: true } })
  return deal.preparedSigners === null ? [] : requiredFromPrepared(deal.preparedSigners)
}

/** How far ahead of today (SAST) a planned start may be (SQL: guardAssetDealPlannedStart). */
export const MAX_PLANNED_START_DAYS = 90

/**
 * Why `plannedStartDate` (YYYY-MM-DD) cannot start a deal whose first
 * instalment is `firstDueDate`, prepared on `today` (SAST); null when it can.
 * The start is from today to MAX_PLANNED_START_DAYS ahead (never backdated:
 * the loan would accrue interest before anyone signed) and before the first
 * instalment. The database refuses the same window
 * (AssetFinanceDeal_planned_start_window).
 */
export function plannedStartProblem(plannedStartDate: string, firstDueDate: string, today: string, advance = false): string | null {
  let start: number
  try {
    start = toDayNumber(plannedStartDate, "plannedStartDate")
  } catch {
    return "plannedStartDate must be a calendar date YYYY-MM-DD"
  }
  const day = toDayNumber(today)
  if (start < day) return `The planned start date may not be in the past (today is ${today})`
  if (start > day + MAX_PLANNED_START_DAYS) {
    return `The planned start date may be at most ${MAX_PLANNED_START_DAYS} days ahead (${fromDayNumber(day + MAX_PLANNED_START_DAYS)})`
  }
  // A rental in advance is paid on the commencement date: the lease starts on its first due date.
  if (advance) return start === toDayNumber(firstDueDate) ? null : `A lease with rentals in advance starts on its first due date (${firstDueDate})`
  return start < toDayNumber(firstDueDate) ? null : `The planned start date must be before the first instalment (${firstDueDate})`
}

export async function prepareDealDocuments(
  actor: SigningActor,
  dealId: string,
  plannedStartDate?: string,
): Promise<PrepareResult> {
  const { tenantId } = actor
  const borrower = await prisma.assetFinanceDeal.findFirst({ where: { id: dealId, tenantId }, select: { entityId: true, application: { select: { ncaRegime: true } } } })
  if (borrower?.entityId && borrower.application.ncaRegime === "NCA") {
    const { prepareEntityNcaDocuments } = await import("./nca-entity-signing")
    return prepareEntityNcaDocuments(actor, dealId)
  }
  const today = sastCalendarDate(new Date())
  const status = await prisma.assetFinanceDeal.findFirst({ where: { id: dealId, tenantId }, select: { status: true, firstDueDate: true, rentalTiming: true } })
  if (!status) return { kind: "not_found" }
  if (status.status !== "APPROVED") return { kind: "not_approved", status: status.status }
  const advance = status.rentalTiming === "ADVANCE"
  const start = plannedStartDate ?? (advance ? isoOfDbDate(status.firstDueDate) : today)
  const startProblem = plannedStartProblem(start, isoOfDbDate(status.firstDueDate), today, advance)
  if (startProblem) return { kind: "invalid_start", error: startProblem }

  // Throws DealDocumentError / LenderIdentityError: the caller refuses with the reason.
  const data = await loadDealDocumentData(prisma, tenantId, dealId, { plannedStartDate: start })
  if (!data) return { kind: "not_found" }
  if (!data.requiredSigners.some((s) => s.document === "AGREEMENT")) return { kind: "no_authority" }

  const stored = new Map<string, StoredDocument>()
  try {
    for (const signer of data.requiredSigners) {
      const key = documentKey(signer)
      if (stored.has(key)) continue
      const rendered = await renderDealDocument(data, signer.document, signer.clientId)
      const { storagePath } = await saveFile(rendered.bytes, "application/pdf")
      stored.set(key, { sha256: rendered.sha256, storagePath })
    }
    const result = await prisma.$transaction(async (tx) => {
      const deal = await lockDeal(tx, tenantId, dealId)
      if (!deal) return { result: { kind: "not_found" } as const, released: [] }
      if (deal.status !== "APPROVED") return { result: { kind: "not_approved", status: deal.status } as const, released: [] }
      const existing = await tx.dealSigner.findMany({
        where: { tenantId, dealId },
        select: { id: true, clientId: true, document: true, method: true, documentStoragePath: true },
      })
      if (existing.some((row) => row.method !== null)) return { result: { kind: "signing_started" } as const, released: [] }
      const now = await requiredBorrowerSigners(tx, tenantId, deal)
      if (now.map(signerKey).join("|") !== data.requiredSigners.map(signerKey).join("|")) {
        return { result: { kind: "people_changed" } as const, released: [] }
      }

      const wanted = new Set(now.map(signerKey))
      const stale = existing.filter((row) => !wanted.has(signerKey(row)))
      if (stale.length > 0) await tx.dealSigner.deleteMany({ where: { tenantId, id: { in: stale.map((r) => r.id) } } })
      const bound = []
      for (const signer of now) {
        const doc = stored.get(documentKey(signer))
        if (!doc) throw new Error(`No rendered document for ${signerKey(signer)}`)
        const binding = { documentSha256: doc.sha256, documentStoragePath: doc.storagePath }
        await tx.dealSigner.upsert({
          where: { dealId_clientId_document: { dealId, clientId: signer.clientId, document: signer.document }, tenantId },
          create: { tenantId, dealId, clientId: signer.clientId, role: signer.role, document: signer.document, ...binding },
          update: binding,
        })
        bound.push({ clientId: signer.clientId, document: signer.document, documentSha256: doc.sha256 })
      }
      const p = data.pricing
      const terms = {
        plannedStartDate: dbDate(start),
        signedBaseInstalmentCents: p.baseInstalmentCents,
        signedResultingRate: new Prisma.Decimal(p.annualRate),
        signedTotalInterestCents: p.totalInterestCents,
        signedArrearsMarginRate: p.arrearsMarginRate === null ? null : new Prisma.Decimal(p.arrearsMarginRate),
        signedCollectionFeeCents: p.collectionFeeCents,
        preparedSigners: preparedSignerSet(now),
      }
      await tx.assetFinanceDeal.updateMany({ where: { id: dealId, tenantId, status: "APPROVED" }, data: terms })
      await logAuditStrict(
        {
          tenantId,
          userId: actor.userId,
          userEmail: actor.userEmail ?? undefined,
          action: AuditAction.ASSET_DEAL_DOCUMENTS_PREPARED,
          entity: "AssetFinanceDeal",
          entityId: dealId,
          newValue: {
            signers: bound, removedSigners: stale.map(signerKey), legalWordingApproved: data.legalWordingApproved,
            plannedStartDate: start, baseInstalmentCents: p.baseInstalmentCents, resultingRate: p.annualRate,
            totalInterestCents: p.totalInterestCents, arrearsMarginRate: p.arrearsMarginRate, collectionFeeCents: p.collectionFeeCents,
          },
        },
        tx,
      )
      return {
        result: { kind: "prepared", signers: bound.length } as const,
        released: existing.map((row) => row.documentStoragePath).filter((p): p is string => p !== null),
      }
    })
    // Bytes no row points at any more (an earlier preparation), or that this
    // attempt wrote and did not bind, hold personal data: remove them.
    const kept = result.result.kind === "prepared" ? new Set([...stored.values()].map((d) => d.storagePath)) : new Set<string>()
    const unused = [...result.released, ...[...stored.values()].map((d) => d.storagePath)].filter((p) => !kept.has(p))
    await Promise.all([...new Set(unused)].map((p) => deleteFile(p)))
    return result.result
  } catch (error) {
    await Promise.all([...stored.values()].map((d) => deleteFile(d.storagePath)))
    throw error
  }
}

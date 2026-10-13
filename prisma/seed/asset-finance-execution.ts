/**
 * Execution of the asset-finance demo deal, through the lib functions the
 * signing, payout and booking routes call: documents prepared; the director
 * e-signs the agreement, the resolution and their own suretyship; the
 * separate surety's suretyship is signed in wet ink (scan uploaded by the
 * officer, confirmed by the first loan admin); contracted; every payout
 * checklist item confirmed with a staff evidence document; the payout created
 * by one loan admin and approved by the other; booked on `bookingDate`; then
 * part-paid through applyManualReceipt. Each step runs only from the state
 * before it, so a rerun writes nothing.
 */
import type { PayoutChecklistItemKind } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import { prepareDealDocuments } from "@/lib/asset-finance/signing-prepare"
import { recordESignature } from "@/lib/asset-finance/signing-esign"
import { confirmWetInkScan, uploadWetInkScan } from "@/lib/asset-finance/signing-wet-ink"
import { SIGNED_DOC_TYPE } from "@/lib/asset-finance/signing"
import { contractDeal } from "@/lib/asset-finance/signing-contract"
import { CHECKLIST_EVIDENCE_TYPES, CHECKLIST_LABELS } from "@/lib/asset-finance/payout-checklist"
import { confirmChecklistItem } from "@/lib/asset-finance/payout-checklist-store"
import { approvePayout, createPayout } from "@/lib/asset-finance/payout"
import { bookDeal } from "@/lib/asset-finance/booking"
import { ensureDocument, syntheticUpload, type SeedActor } from "./asset-finance-documents"
import { dealActor, type SeedStaff } from "./asset-finance-deal"
import { PAID_INSTALMENTS } from "./asset-finance-data"

const HOUR_MS = 3_600_000

/** APPROVED → CONTRACTED: prepare (the loan starts on `bookingDate`), sign every required signer row, contract. */
async function signAndContract(tenantId: string, staff: SeedStaff, dealId: string, directorId: string, bookingDate: string): Promise<void> {
  const officer = dealActor(tenantId, staff.officer)
  const signers = await prisma.dealSigner.count({ where: { tenantId, dealId, method: { not: null } } })
  if (signers === 0) {
    const prepared = await prepareDealDocuments(officer, dealId, bookingDate)
    if (prepared.kind !== "prepared") throw new Error(`Seed: documents not prepared (${prepared.kind})`)
  }
  const rows = await prisma.dealSigner.findMany({
    where: { tenantId, dealId },
    select: { id: true, clientId: true, document: true, method: true, documentSha256: true, confirmedAt: true, client: { select: { firstName: true, lastName: true, email: true } } },
  })
  for (const row of rows) {
    const name = `${row.client.firstName} ${row.client.lastName}`
    if (row.clientId === directorId) {
      if (row.method !== null || !row.documentSha256) continue
      const signed = await recordESignature({
        tenantId, clientId: row.clientId, clientEmail: row.client.email, signerId: row.id,
        input: { signature: name, documentSha256: row.documentSha256 }, ip: null,
      })
      if (signed.kind !== "signed") throw new Error(`Seed: e-signature refused (${JSON.stringify(signed)})`)
      continue
    }
    // Every other signer signs on paper: the officer uploads the scan, a second user confirms it.
    if (row.method === null) {
      const upload = await syntheticUpload(SIGNED_DOC_TYPE[row.document], `Signed ${row.document.toLowerCase()} (wet ink) - ${name}`, Object.values(SIGNED_DOC_TYPE), null)
      const uploaded = await uploadWetInkScan(officer, dealId, row.id, upload)
      if (uploaded.kind !== "done") throw new Error(`Seed: wet-ink upload refused (${JSON.stringify(uploaded)})`)
    }
    if (!row.confirmedAt) {
      const confirmed = await confirmWetInkScan(dealActor(tenantId, staff.adminOne), dealId, row.id)
      if (confirmed.kind !== "done") throw new Error(`Seed: wet-ink confirmation refused (${JSON.stringify(confirmed)})`)
    }
  }
  const contracted = await contractDeal(officer, dealId)
  if (contracted.kind !== "contracted") throw new Error(`Seed: contract refused (${JSON.stringify(contracted)})`)
}

/** Confirm every open required checklist item, each with a staff-uploaded evidence document of the deal. */
async function confirmChecklist(tenantId: string, officer: SeedActor, dealId: string, entityId: string): Promise<void> {
  const deal = await prisma.assetFinanceDeal.findFirstOrThrow({ where: { id: dealId, tenantId }, select: { asset: { select: { serialNumber: true } } } })
  const open = await prisma.payoutChecklistItem.findMany({ where: { tenantId, dealId, required: true, confirmedAt: null }, select: { item: true } })
  for (const { item } of open) {
    const types = CHECKLIST_EVIDENCE_TYPES[item as PayoutChecklistItemKind]
    const evidenceDocumentId = types.length === 0
      ? null
      : await ensureDocument(tenantId, officer, entityId, types[0], `${CHECKLIST_LABELS[item]} (TEST evidence)`, dealId)
    const result = await confirmChecklistItem(dealActor(tenantId, officer), dealId, item, {
      evidenceDocumentId,
      attestedSerial: item === "SUPPLIER_INVOICE_MATCHES_ASSET" ? deal.asset.serialNumber : null,
      note: "Synthetic evidence checked (TEST)",
    })
    if (result.kind !== "confirmed") throw new Error(`Seed: checklist item ${item} refused (${JSON.stringify(result)})`)
  }
}

/** CONTRACTED → BOOKED on `bookingDate` (the booking function's start-date parameter). */
async function payOutAndBook(tenantId: string, staff: SeedStaff, dealId: string, bookingDate: string): Promise<void> {
  if (!(await prisma.payout.findFirst({ where: { tenantId, dealId }, select: { id: true } }))) {
    const created = await createPayout(dealActor(tenantId, staff.adminOne), dealId)
    if (created.kind !== "created") throw new Error(`Seed: payout refused (${JSON.stringify(created)})`)
  }
  const payout = await prisma.payout.findFirstOrThrow({ where: { tenantId, dealId }, select: { status: true } })
  if (payout.status === "PENDING_APPROVAL") {
    const approved = await approvePayout(dealActor(tenantId, staff.adminTwo), dealId)
    if (approved.kind !== "approved") throw new Error(`Seed: payout approval refused (${approved.kind})`)
  }
  const booked = await bookDeal(dealActor(tenantId, staff.adminOne), dealId, bookingDate)
  if (booked.kind !== "booked") throw new Error(`Seed: booking refused (${JSON.stringify(booked)})`)
}

/**
 * Part-payment: the first PAID_INSTALMENTS instalments, each paid in full on
 * its due date (10:00 SAST), through applyManualReceipt as a staff capture.
 * Skipped once the loan has any payment.
 */
async function recordReceipts(tenantId: string, officer: SeedActor, loanId: string): Promise<void> {
  if ((await prisma.payment.count({ where: { tenantId, loanId } })) > 0) return
  const loan = await prisma.loan.findFirstOrThrow({ where: { id: loanId, tenantId }, select: { reference: true } })
  const rows = await prisma.repaymentSchedule.findMany({
    where: { tenantId, loanId, totalDue: { gt: 0 } },
    orderBy: { installmentNo: "asc" },
    take: PAID_INSTALMENTS,
    select: { installmentNo: true, dueDate: true, totalDue: true },
  })
  for (const row of rows) {
    // dueDate is SAST midnight; 10 hours later is 10:00 SAST on the due day.
    const receivedAt = new Date(row.dueDate.getTime() + 10 * HOUR_MS)
    if (receivedAt > new Date()) break
    await applyManualReceipt(prisma, {
      loanId, tenantId, amount: row.totalDue, paymentMethod: "EFT", reference: loan.reference,
      notes: `Synthetic receipt for instalment ${row.installmentNo} (demo seed)`,
      capturedById: officer.id, capturedByEmail: officer.email,
      idempotencyKey: `seed-af-${loan.reference}-${row.installmentNo}`, receivedAt,
    })
  }
}

/** Take the APPROVED company deal through to a booked, part-paid loan. */
export async function executeCompanyDeal(
  tenantId: string,
  staff: SeedStaff,
  dealId: string,
  people: { directorId: string; entityId: string },
  bookingDate: string,
): Promise<void> {
  const status = async () => (await prisma.assetFinanceDeal.findFirstOrThrow({ where: { id: dealId, tenantId }, select: { status: true } })).status
  if ((await status()) === "APPROVED") await signAndContract(tenantId, staff, dealId, people.directorId, bookingDate)
  if ((await status()) === "CONTRACTED") {
    await confirmChecklist(tenantId, staff.officer, dealId, people.entityId)
    await payOutAndBook(tenantId, staff, dealId, bookingDate)
  }
  const deal = await prisma.assetFinanceDeal.findFirstOrThrow({ where: { id: dealId, tenantId }, select: { status: true, loanId: true } })
  if (deal.status !== "BOOKED" || !deal.loanId) throw new Error(`Seed: the company deal should be BOOKED, it is ${deal.status}`)
  await recordReceipts(tenantId, staff.officer, deal.loanId)
}

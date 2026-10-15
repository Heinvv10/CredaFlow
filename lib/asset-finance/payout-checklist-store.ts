/**
 * Payout checklist rows (goal §4.10): created when a deal is contracted,
 * confirmed one by one by staff with their evidence. The rules are in
 * ./payout-checklist.ts; guardPayoutChecklistItem (migration 20261013113000)
 * refuses the same things in the database, so these checks are the readable
 * refusal, not the only one.
 */
import type { DealDocumentKind, PayoutChecklistItemKind } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { getLenderIdentity } from "@/lib/config/identity"
import {
  CHECKLIST_EVIDENCE_TYPES,
  CHECKLIST_KINDS,
  SIGNING_ITEMS,
  assetBlocker,
  requiredChecklistKinds,
  serialAttestationMatches,
} from "./payout-checklist"
import { normaliseAssetIdentifier } from "./asset-identifier"
import { outstandingSigners } from "./signing"
import { lockDeal, preparedRequiredSigners, type SigningActor, type SigningTx } from "./signing-prepare"

const SIGNING_DOCUMENT: Partial<Record<PayoutChecklistItemKind, DealDocumentKind>> = {
  SIGNED_AGREEMENT: "AGREEMENT",
  SIGNED_SURETYSHIPS: "SURETYSHIP",
  SIGNED_RESOLUTION: "RESOLUTION",
}

const ASSET_SELECT = {
  serialNumber: true, vin: true, registrationNumber: true, natisTitleholder: true, natisOwner: true, trackerId: true, lenderNotedConfirmed: true,
} as const

/**
 * One row per checklist kind for a deal that is CONTRACTED in this
 * transaction; `required` from the requirement table. Called by contractDeal.
 */
export async function createPayoutChecklist(tx: SigningTx, tenantId: string, dealId: string): Promise<void> {
  const deal = await tx.assetFinanceDeal.findFirstOrThrow({
    where: { id: dealId, tenantId },
    select: { contractType: true, asset: { select: { registrationNumber: true } } },
  })
  const required = new Set(requiredChecklistKinds(deal.contractType, deal.asset))
  await tx.payoutChecklistItem.createMany({
    data: CHECKLIST_KINDS.map((item) => ({ tenantId, dealId, item, required: required.has(item) })),
  })
}

export interface ConfirmInput {
  evidenceDocumentId: string | null
  /** SUPPLIER_INVOICE_MATCHES_ASSET: the serial or VIN as typed off the invoice. */
  attestedSerial: string | null
  note: string | null
}

export type ConfirmResult =
  | { kind: "not_found" }
  | { kind: "not_contracted"; status: string }
  | { kind: "already_confirmed" }
  | { kind: "refused"; reason: string; error: string }
  | { kind: "confirmed" }

const refused = (reason: string, error: string): ConfirmResult => ({ kind: "refused", reason, error })

async function evidenceProblem(
  tx: SigningTx,
  tenantId: string,
  dealId: string,
  item: PayoutChecklistItemKind,
  evidenceDocumentId: string | null,
): Promise<ConfirmResult | null> {
  const types = CHECKLIST_EVIDENCE_TYPES[item]
  if (types.length === 0) {
    return evidenceDocumentId === null ? null : refused("evidence_not_applicable", "A signing item's evidence is the signer record; no document is attached")
  }
  if (evidenceDocumentId === null) return refused("evidence_missing", "Choose the evidence document")
  const doc = await tx.entityDocument.findFirst({
    where: { id: evidenceDocumentId, tenantId, dealId, deletedAt: null },
    select: { docType: true, uploadedByType: true },
  })
  if (!doc) return refused("evidence_not_on_deal", "The evidence must be a live document of this deal")
  if (doc.uploadedByType !== "staff") return refused("evidence_not_staff", "Payout evidence is a staff upload")
  if (!types.includes(doc.docType)) return refused("evidence_wrong_type", `The evidence must be of type ${types.join(" or ")}`)
  return null
}

async function signingProblem(tx: SigningTx, tenantId: string, dealId: string, document: DealDocumentKind) {
  // The signer set fixed when the documents were prepared, as the contract gate counts it.
  const required = await preparedRequiredSigners(tx, tenantId, dealId)
  const rows = await tx.dealSigner.findMany({
    where: { tenantId, dealId },
    select: { clientId: true, document: true, method: true, signedAt: true, signatureSha256: true, scanDocumentId: true, confirmedById: true, confirmedAt: true },
  })
  // A deal with no surety has no suretyship to sign: that item is satisfied.
  const open = outstandingSigners(required, rows).filter((o) => o.document === document)
  return open.length === 0 ? null : refused("signers_outstanding", `${open.length} required signature(s) on this document are outstanding`)
}

export async function confirmChecklistItem(
  actor: SigningActor,
  dealId: string,
  item: PayoutChecklistItemKind,
  input: ConfirmInput,
): Promise<ConfirmResult> {
  const { tenantId } = actor
  return prisma.$transaction(async (tx) => {
    const locked = await lockDeal(tx, tenantId, dealId)
    if (!locked) return { kind: "not_found" }
    if (locked.status !== "CONTRACTED") return { kind: "not_contracted", status: locked.status }
    const row = await tx.payoutChecklistItem.findFirst({ where: { tenantId, dealId, item }, select: { id: true, confirmedAt: true } })
    if (!row) return { kind: "not_found" }
    if (row.confirmedAt) return { kind: "already_confirmed" }

    const deal = await tx.assetFinanceDeal.findFirstOrThrow({
      where: { id: dealId, tenantId },
      select: { supplierId: true, contractType: true, asset: { select: ASSET_SELECT } },
    })
    const evidence = await evidenceProblem(tx, tenantId, dealId, item, input.evidenceDocumentId)
    if (evidence) return evidence
    const document = SIGNING_DOCUMENT[item]
    if (document) {
      const signing = await signingProblem(tx, tenantId, dealId, document)
      if (signing) return signing
    }
    if (item === "SUPPLIER_INVOICE_MATCHES_ASSET" && !serialAttestationMatches(input.attestedSerial ?? "", deal.asset)) {
      return refused("serial_mismatch", "The serial or VIN typed from the invoice does not match the asset")
    }
    if (item === "SUPPLIER_BANK_VERIFIED") {
      const account = await tx.supplierBankAccount.findFirst({ where: { tenantId, supplierId: deal.supplierId, status: "APPROVED" }, select: { id: true } })
      if (!account) return refused("no_approved_account", "The supplier has no APPROVED bank account")
    }
    const lenderName = item === "NATIS_TITLEHOLDER" ? (await getLenderIdentity(tenantId)).legalName : null
    const blocker = assetBlocker(item, deal.asset, lenderName, deal.contractType === "OPERATING_LEASE" || deal.contractType === "FULL_MAINTENANCE_LEASE")
    if (blocker) return refused("asset_not_ready", blocker)

    const confirmedAt = new Date()
    const attestedIdentifier = item === "SUPPLIER_INVOICE_MATCHES_ASSET" ? normaliseAssetIdentifier(input.attestedSerial ?? "") : null
    const note = attestedIdentifier !== null
      ? [`Serial/VIN attested from the invoice: ${attestedIdentifier}`, input.note].filter(Boolean).join(" · ")
      : input.note
    const updated = await tx.payoutChecklistItem.updateMany({
      where: { id: row.id, tenantId, confirmedAt: null },
      data: { confirmedById: actor.userId, confirmedAt, evidenceDocumentId: input.evidenceDocumentId, attestedIdentifier, note },
    })
    if (updated.count !== 1) return { kind: "already_confirmed" }
    await logAuditStrict({
      tenantId,
      userId: actor.userId,
      userEmail: actor.userEmail ?? undefined,
      action: AuditAction.ASSET_PAYOUT_CHECKLIST_CONFIRMED,
      entity: "PayoutChecklistItem",
      entityId: row.id,
      newValue: { dealId, item, evidenceDocumentId: input.evidenceDocumentId, attestedIdentifier, note, signingItem: SIGNING_ITEMS.includes(item) },
    }, tx)
    return { kind: "confirmed" }
  })
}

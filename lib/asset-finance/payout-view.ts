// Read model for the staff deal page's "Payout" panel (goal §4.10): the
// checklist with its evidence, the deal's documents to pick evidence from,
// the payout, and the booked loan and tax invoice. JSON-safe.
import type { AssetDealStatus, EntityDocumentType, PayoutChecklistItemKind, PayoutStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { CHECKLIST_EVIDENCE_TYPES, CHECKLIST_KINDS, checklistLabel, payoutAmountCents, requiredChecklistKinds } from "./payout-checklist"

export interface ChecklistItemView {
  item: PayoutChecklistItemKind
  label: string
  required: boolean
  evidenceTypes: readonly EntityDocumentType[]
  confirmedAt: string | null
  confirmedBy: string | null
  evidence: { id: string; fileName: string } | null
  note: string | null
}

export interface PayoutPanel {
  sureties: { signerId: string; name: string; maritalRegime: string; verifiedAt: string | null }[]
  dealStatus: AssetDealStatus
  entityId: string | null
  checklist: ChecklistItemView[]
  documents: { id: string; fileName: string; docType: EntityDocumentType }[]
  payoutAmountCents: number
  dualApprovalThresholdCents: number | null
  /** TenantConfig.requireSegregationOfDuties: every payout needs a second approver. */
  segregationOfDuties: boolean
  approvedAccount: { bankName: string; accountNumberTail: string; accountHolder: string } | null
  payout: {
    status: PayoutStatus
    amountCents: number
    dualApprovalRequired: boolean
    createdById: string
    createdBy: string
    approvedBy: string | null
    releasedAt: string | null
  } | null
  loan: { id: string; reference: string } | null
  taxInvoice: { id: string; invoiceNumber: string } | null
}

const userLabel = (u: { name: string | null; email: string } | null) => (u ? u.name?.trim() || u.email : null)

export async function loadPayoutPanel(tenantId: string, dealId: string): Promise<PayoutPanel | null> {
  const deal = await prisma.assetFinanceDeal.findFirst({
    where: { id: dealId, tenantId },
    select: {
      status: true, entityId: true, contractType: true, supplierId: true, depositCents: true, tradeInCents: true,
      asset: { select: { cashPriceExclVatCents: true, vatCents: true, registrationNumber: true } },
      signers: { where: { document: "SURETYSHIP" }, select: { id: true, client: { select: { firstName: true, lastName: true } }, suretyConsent: { select: { maritalRegime: true, verifiedAt: true } } } },
      checklist: {
        select: {
          item: true, confirmedAt: true, note: true,
          confirmedBy: { select: { name: true, email: true } },
          evidenceDocument: { select: { id: true, fileName: true } },
        },
      },
      documents: {
        where: { deletedAt: null, uploadedByType: "staff" },
        orderBy: { createdAt: "desc" },
        select: { id: true, fileName: true, docType: true },
      },
      payout: {
        select: {
          status: true, amountCents: true, dualApprovalRequired: true, createdById: true, releasedAt: true,
          createdBy: { select: { name: true, email: true } },
          approvedBy: { select: { name: true, email: true } },
          supplierBankAccount: { select: { bankName: true, accountNumber: true, accountHolder: true } },
        },
      },
      loan: { select: { id: true, reference: true, taxInvoices: { select: { id: true, invoiceNumber: true }, take: 1 } } },
    },
  })
  if (!deal) return null
  const [config, account] = await Promise.all([
    prisma.tenantConfig.findUnique({ where: { tenantId }, select: { assetPayoutDualApprovalCents: true, requireSegregationOfDuties: true } }),
    deal.payout ? Promise.resolve(deal.payout.supplierBankAccount) : prisma.supplierBankAccount.findFirst({
      where: { tenantId, supplierId: deal.supplierId, status: "APPROVED" },
      select: { bankName: true, accountNumber: true, accountHolder: true },
    }),
  ])
  // Requiredness from the asset as it is now (the stored flag is as at contracting).
  const required = new Set(requiredChecklistKinds(deal.contractType, deal.asset))
  const rows = new Map(deal.checklist.map((row) => [row.item, row]))
  const checklist = CHECKLIST_KINDS.flatMap((item): ChecklistItemView[] => {
    const row = rows.get(item)
    if (!row) return []
    return [{
      item,
      label: checklistLabel(item, deal.contractType),
      required: required.has(item),
      evidenceTypes: CHECKLIST_EVIDENCE_TYPES[item],
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      confirmedBy: userLabel(row.confirmedBy),
      evidence: row.evidenceDocument,
      note: row.note,
    }]
  })
  const { payout, loan } = deal
  return {
    sureties: (deal.signers ?? []).map((s) => ({ signerId: s.id, name: `${s.client.firstName} ${s.client.lastName}`, maritalRegime: s.suretyConsent?.maritalRegime ?? "UNKNOWN", verifiedAt: s.suretyConsent?.verifiedAt.toISOString() ?? null })),
    dealStatus: deal.status,
    entityId: deal.entityId,
    checklist,
    documents: deal.documents,
    payoutAmountCents: payoutAmountCents({ ...deal.asset, depositCents: deal.depositCents, tradeInCents: deal.tradeInCents }),
    dualApprovalThresholdCents: config?.assetPayoutDualApprovalCents ?? null,
    // No config row: the trigger treats it as on.
    segregationOfDuties: config?.requireSegregationOfDuties ?? true,
    approvedAccount: account && {
      bankName: account.bankName, accountNumberTail: account.accountNumber.slice(-4), accountHolder: account.accountHolder,
    },
    payout: payout && {
      status: payout.status,
      amountCents: payout.amountCents,
      dualApprovalRequired: payout.dualApprovalRequired,
      createdById: payout.createdById,
      createdBy: userLabel(payout.createdBy) ?? payout.createdById,
      approvedBy: userLabel(payout.approvedBy),
      releasedAt: payout.releasedAt?.toISOString() ?? null,
    },
    loan: loan && { id: loan.id, reference: loan.reference },
    taxInvoice: loan?.taxInvoices[0] ?? null,
  }
}

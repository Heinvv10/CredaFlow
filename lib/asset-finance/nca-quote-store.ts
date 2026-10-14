import { createHash, randomUUID } from "node:crypto"
import { getLenderIdentity } from "@/lib/config/identity"
import { verifyAppliedCreditLifeDisclosure } from "@/lib/insurance/credit-life-election.server"
import { deleteFile, saveFile } from "@/lib/storage"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { RegimeTx } from "./classification"
import { resolveRate } from "./deal-structure"
import { sastCalendarDate } from "@/lib/date/sast"
import { termsFromDeal, DEAL_STRUCTURE_SELECT } from "./deal-terms"
import { solveNcaDealStructure } from "./nca-structure"
import { createAssetPasqEvidence, pasqJson } from "./nca-evidence"
import { renderNcaAssetQuote } from "./documents/nca/quote-pdf"

export type IssueNcaQuoteResult =
  | { kind: "not_found" }
  | { kind: "not_ready"; reason: string }
  | { kind: "issued"; documentId: string; sha256: string }

export async function issueAssetNcaQuote(
  tx: RegimeTx,
  actor: { tenantId: string; userId: string; userEmail?: string },
  dealId: string,
): Promise<IssueNcaQuoteResult> {
  const deal = await tx.assetFinanceDeal.findFirst({
    where: { id: dealId, tenantId: actor.tenantId },
    select: {
      id: true, status: true, contractType: true, clientId: true,
      ...DEAL_STRUCTURE_SELECT,
      application: { select: {
        id: true, reference: true, status: true, productId: true, appliedAmount: true, appliedTermDays: true,
        pasqDocumentId: true, creditLifeElection: true, creditLifeProductId: true, creditLifeProductName: true,
        creditLifeInsurerId: true, creditLifeInsurerName: true, creditLifeMonthlyPremiumCents: true,
        creditLifeDisclosureVersion: true, creditLifeDisclosureSha256: true,
        creditLifeDisclosureAcknowledgedAt: true, creditLifeDisclosureAcknowledgedBy: true,
      } },
      client: { select: { id: true, firstName: true, lastName: true, idNumber: true, addressLine1: true, city: true, province: true, postalCode: true } },
      asset: { select: { make: true, model: true, year: true, serialNumber: true, vin: true, cashPriceExclVatCents: true, vatCents: true } },
    },
  })
  if (!deal) return { kind: "not_found" }
  if (deal.status !== "APPROVED" || deal.application.status !== "APPROVED" || !deal.client || !deal.clientId) {
    return { kind: "not_ready", reason: "Only an approved natural-person NCA asset deal can issue this quotation" }
  }
  if (deal.application.pasqDocumentId) return { kind: "not_ready", reason: "The quotation was already issued" }
  if (deal.contractType !== "INSTALMENT_SALE" && deal.contractType !== "FINANCE_LEASE") {
    return { kind: "not_ready", reason: "This agreement type has no NCA asset document" }
  }
  const creditLife = verifyAppliedCreditLifeDisclosure(deal.application)
  if (!creditLife.ok) return { kind: "not_ready", reason: `Record the client's credit-life election first (${creditLife.reason})` }
  const terms = termsFromDeal(deal)
  const generatedAt = new Date()
  const startDate = sastCalendarDate(generatedAt)
  const rate = await resolveRate(tx, actor.tenantId, terms.rate, startDate)
  if ("error" in rate) return { kind: "not_ready", reason: rate.error }
  const solved = solveNcaDealStructure(deal.asset, terms, rate, startDate)
  if (!solved.ok) return { kind: "not_ready", reason: solved.error }
  if (solved.result.rows.some((row) => row.principalCents < 0)) {
    return { kind: "not_ready", reason: "NCA schedules may not capitalise unpaid interest; adjust the payment weights" }
  }
  const evidence = createAssetPasqEvidence({
    tenantId: actor.tenantId, applicationId: deal.application.id, clientId: deal.clientId,
    productId: deal.application.productId, termDays: deal.application.appliedTermDays, generatedAt, solved,
    initiationFeeCents: terms.financedFeesCents, creditLife: creditLife.evidence,
  })
  const lender = await getLenderIdentity(actor.tenantId)
  const bytes = await renderNcaAssetQuote({
    reference: deal.application.reference, documentDate: generatedAt, contractType: deal.contractType,
    lender: { legalName: lender.legalName, ncrNumber: lender.ncrNumber, registeredOfficeLines: lender.registeredOfficeLines },
    borrower: {
      name: `${deal.client.firstName} ${deal.client.lastName}`, identityNumber: deal.client.idNumber,
      addressLines: [deal.client.addressLine1, deal.client.city, deal.client.province, deal.client.postalCode].filter((v): v is string => !!v),
    },
    asset: { description: `${deal.asset.year} ${deal.asset.make} ${deal.asset.model}`, serialNumber: deal.asset.vin ?? deal.asset.serialNumber },
    pricing: {
      cashPriceCents: deal.asset.cashPriceExclVatCents + deal.asset.vatCents, depositCents: terms.depositCents,
      principalCents: evidence.calculator.principalCents, annualRate: rate.annualRate,
      initiationFeeCents: evidence.calculator.initiationFeeCents,
      monthlyServiceFeeCents: solved.result.rows[0]?.feesCents === undefined ? 0 : solved.result.rows[0].feesCents - terms.financedFeesCents,
      creditLifePremiumCents: evidence.creditLife.monthlyPremiumCents, instalmentCents: evidence.billing.recurringPaymentCents,
      balloonCents: terms.balloonCents, totalInterestCents: evidence.calculator.totalInterestCents,
      totalCostOfCreditCents: evidence.totalCostOfCreditCents, totalRepayableCents: evidence.billing.totalRepayableCents,
    },
    schedule: evidence.billing.schedule.map((row) => ({
      installmentNo: row.installmentNo, dueDate: row.dueDate.slice(0, 10), principalCents: row.principalDueCents,
      interestCents: row.interestDueCents, feesCents: row.feesDueCents, totalCents: row.totalDueCents, closingBalanceCents: row.closingBalanceCents,
    })),
  })
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const documentId = randomUUID()
  const stored = await saveFile(bytes, "application/pdf")
  try {
    await tx.clientDocument.create({ data: {
      id: documentId, tenantId: actor.tenantId, clientId: deal.clientId, docType: "FORM_20_PRE_AGREEMENT",
      fileUrl: `/api/documents/${documentId}/view`, fileName: `asset-pasq-${deal.application.reference}.pdf`,
      storagePath: stored.storagePath, fileSize: stored.fileSize, mimeType: "application/pdf", contentSha256: sha256,
      uploadedByType: "staff", uploadedById: actor.userId, extractionStatus: "skipped",
    } })
    await tx.loanApplication.update({ where: { id: deal.application.id, tenantId: actor.tenantId }, data: {
      pasqVersion: evidence.version, pasqGeneratedAt: generatedAt, pasqDocumentId: documentId, pasqDocumentSha256: sha256,
      pasqEvidence: pasqJson(evidence), pasqEvidenceSha256: evidence.evidenceSha256,
    } })
    await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail,
      action: AuditAction.ASSET_NCA_QUOTE_ISSUED, entity: "AssetFinanceDeal", entityId: deal.id,
      newValue: { applicationId: deal.application.id, documentId, documentSha256: sha256, evidenceSha256: evidence.evidenceSha256 },
    }, tx)
  } catch (error) {
    await deleteFile(stored.storagePath)
    throw error
  }
  return { kind: "issued", documentId, sha256 }
}

import { createHash, randomUUID } from "node:crypto"
import { pasqEvidenceIsIntact } from "@/lib/compliance/pasq"
import { getLenderIdentity } from "@/lib/config/identity"
import { providerCountersignatureEnvelopeSha256, providerCountersignatureSha256 } from "@/lib/compliance/provider-countersign"
import { documentBytesMatchSha256 } from "@/lib/documents/content-integrity"
import { deleteFile, readFile, saveFile } from "@/lib/storage"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { resolveRate } from "./deal-structure"
import { renderNcaAssetAgreement } from "./documents/nca/agreement-pdf"
import { legalWordingApproved } from "./documents/nca/legal-wording-approved"
import { dbDate } from "./dates"
import { createPayoutChecklist } from "./payout-checklist-store"
import { checkSigningOtp, consumeSigningOtp, SigningOtpRefusedError } from "@/lib/signing-otp/challenge"
import { isSigningOtpRequired } from "@/lib/signing-otp/policy"

type AgreementResult =
  | { kind: "not_found" }
  | { kind: "not_ready"; reason: string }
  | { kind: "signing_otp"; reason: SigningOtpRefusedError["reason"] }
  | { kind: "done"; documentId?: string; sha256?: string }

const SELECT = {
  id: true, tenantId: true, clientId: true, status: true, contractType: true, decidedAt: true,
  depositCents: true, balloonCents: true, rateBasis: true, rateMargin: true, fixedRate: true,
  application: { select: {
    id: true, reference: true, status: true, pasqEvidence: true, pasqDocumentSha256: true,
    pasqAcknowledgedSha256: true, agreementGeneratedAt: true, agreementDocumentId: true,
    agreementDocumentSha256: true, agreementSignedAt: true, agreementSignedMethod: true, agreementSignatureData: true,
  } },
  client: { select: { id: true, firstName: true, lastName: true, idNumber: true, addressLine1: true, city: true, province: true, postalCode: true } },
  asset: { select: { make: true, model: true, year: true, serialNumber: true, vin: true, cashPriceExclVatCents: true, vatCents: true } },
} as const

export async function issueAssetNcaAgreement(actor: { tenantId: string; userId: string; userEmail?: string }, dealId: string): Promise<AgreementResult> {
  const deal = await prisma.assetFinanceDeal.findFirst({ where: { id: dealId, tenantId: actor.tenantId }, select: SELECT })
  if (!deal) return { kind: "not_found" }
  const app = deal.application
  if (deal.status !== "APPROVED" || app.status !== "APPROVED" || !deal.client || !deal.clientId) return { kind: "not_ready", reason: "Only an approved natural-person NCA deal can issue this agreement" }
  if (deal.contractType !== "INSTALMENT_SALE" && deal.contractType !== "FINANCE_LEASE") return { kind: "not_ready", reason: "This agreement type has no NCA asset document" }
  if (app.agreementDocumentId) return { kind: "not_ready", reason: "The agreement was already issued" }
  if (!app.pasqDocumentSha256 || app.pasqAcknowledgedSha256 !== app.pasqDocumentSha256) return { kind: "not_ready", reason: "The client must review and acknowledge the current quotation first" }
  if (!pasqEvidenceIsIntact(app.pasqEvidence)) return { kind: "not_ready", reason: "The quotation evidence is incomplete" }
  const evidence = app.pasqEvidence
  const clientId = deal.clientId
  const startDate = sastCalendarDate(new Date(evidence.calculator.startDate))
  const rate = await resolveRate(prisma, actor.tenantId, {
    basis: deal.rateBasis, margin: deal.rateMargin?.toString() ?? null, fixedRate: deal.fixedRate?.toString() ?? null,
  }, startDate)
  if ("error" in rate) return { kind: "not_ready", reason: rate.error }
  const [lender, approved] = await Promise.all([getLenderIdentity(actor.tenantId), legalWordingApproved(prisma, actor.tenantId)])
  const generatedAt = new Date(evidence.calculator.startDate)
  const bytes = await renderNcaAssetAgreement({
    legalWordingApproved: approved, reference: app.reference, documentDate: generatedAt, contractType: deal.contractType,
    lender: { legalName: lender.legalName, ncrNumber: lender.ncrNumber, registeredOfficeLines: lender.registeredOfficeLines },
    borrower: { name: `${deal.client.firstName} ${deal.client.lastName}`, identityNumber: deal.client.idNumber, addressLines: [deal.client.addressLine1, deal.client.city, deal.client.province, deal.client.postalCode].filter((v): v is string => !!v) },
    asset: { description: `${deal.asset.year} ${deal.asset.make} ${deal.asset.model}`, serialNumber: deal.asset.vin ?? deal.asset.serialNumber },
    pricing: {
      cashPriceCents: deal.asset.cashPriceExclVatCents + deal.asset.vatCents, depositCents: deal.depositCents,
      principalCents: evidence.calculator.principalCents, annualRate: rate.annualRate,
      rateBasis: deal.rateBasis, rateMargin: deal.rateMargin?.toString() ?? null, reference: rate.reference,
      initiationFeeCents: evidence.calculator.initiationFeeCents,
      monthlyServiceFeeCents: Math.round(evidence.calculator.serviceFeesCents / evidence.calculator.schedule.length),
      creditLifePremiumCents: evidence.creditLife.monthlyPremiumCents, instalmentCents: evidence.billing.recurringPaymentCents,
      balloonCents: deal.balloonCents, totalInterestCents: evidence.calculator.totalInterestCents,
      totalCostOfCreditCents: evidence.totalCostOfCreditCents, totalRepayableCents: evidence.billing.totalRepayableCents,
    },
    schedule: evidence.billing.schedule.map((row) => ({
      installmentNo: row.installmentNo, dueDate: sastCalendarDate(new Date(row.dueDate)), principalCents: row.principalDueCents,
      interestCents: row.interestDueCents, feesCents: row.feesDueCents, totalCents: row.totalDueCents, closingBalanceCents: row.closingBalanceCents,
    })),
  })
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const documentId = randomUUID()
  const stored = await saveFile(bytes, "application/pdf")
  try {
    await prisma.$transaction(async (tx) => {
      await tx.clientDocument.create({ data: {
        id: documentId, tenantId: actor.tenantId, clientId, docType: "CREDIT_AGREEMENT",
        fileUrl: `/api/documents/${documentId}/view`, fileName: `credit-agreement-${app.id}.pdf`, storagePath: stored.storagePath,
        fileSize: stored.fileSize, mimeType: "application/pdf", contentSha256: sha256, uploadedByType: "staff", uploadedById: actor.userId, extractionStatus: "skipped",
      } })
      await tx.complianceRecord.create({ data: {
        tenantId: actor.tenantId, type: "AGREEMENT_ARTIFACT", referenceId: app.id, status: "COMPLETED", completedAt: generatedAt,
        data: {
          kind: "CREDIT_AGREEMENT_ARTIFACT", lifecycle: "COMPLETED", applicationId: app.id,
          documentId, documentSha256: sha256, storagePath: stored.storagePath,
          fileName: `credit-agreement-${app.id}.pdf`, fileSize: stored.fileSize,
          creditLifeAutoBundleEligible: evidence.creditLife.election === "ACCEPTED",
          assetFinanceDealId: dealId, draftLegalWording: !approved,
        },
      } })
      const changed = await tx.loanApplication.updateMany({ where: { id: app.id, tenantId: actor.tenantId, status: "APPROVED", agreementGeneratedAt: null }, data: { agreementGeneratedAt: generatedAt, agreementDocumentId: documentId, agreementDocumentSha256: sha256 } })
      if (changed.count !== 1) throw new Error("asset_nca_agreement_changed")
      await tx.dealSigner.create({ data: {
        tenantId: actor.tenantId, dealId, clientId, role: "AUTHORISED_SIGNATORY", document: "AGREEMENT",
        documentSha256: sha256, documentStoragePath: stored.storagePath,
      } })
      await tx.assetFinanceDeal.update({ where: { id: dealId, tenantId: actor.tenantId }, data: {
        plannedStartDate: dbDate(startDate), signedBaseInstalmentCents: evidence.calculator.recurringInstalmentCents,
        signedResultingRate: rate.annualRate, signedTotalInterestCents: evidence.calculator.totalInterestCents,
        signedArrearsMarginRate: null, signedCollectionFeeCents: 0,
        preparedSigners: [{ clientId, document: "AGREEMENT" }],
      } })
      await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail, action: AuditAction.AGREEMENT_GENERATED, entity: "LoanApplication", entityId: app.id, newValue: { documentId, documentSha256: sha256, assetFinanceDealId: dealId, draftLegalWording: !approved } }, tx)
    })
  } catch (error) {
    await deleteFile(stored.storagePath)
    throw error
  }
  return { kind: "done", documentId, sha256 }
}

export async function signAssetNcaAgreement(args: { tenantId: string; clientId: string; clientEmail?: string | null; dealId: string; signature: string; documentSha256: string; ip?: string | null; signingOtpChallengeId?: string | null }): Promise<AgreementResult> {
  const deal = await prisma.assetFinanceDeal.findFirst({ where: { id: args.dealId, tenantId: args.tenantId, clientId: args.clientId }, select: { status: true, application: { select: { id: true, status: true, agreementDocumentId: true, agreementDocumentSha256: true, agreementSignedAt: true } } } })
  if (!deal) return { kind: "not_found" }
  const app = deal.application
  if (deal.status !== "APPROVED" || app.status !== "APPROVED" || app.agreementSignedAt) return { kind: "not_ready", reason: "The agreement is not open for signature" }
  if (!app.agreementDocumentId || app.agreementDocumentSha256 !== args.documentSha256) return { kind: "not_ready", reason: "The agreement shown is no longer current" }
  const documentId = app.agreementDocumentId
  const document = await prisma.clientDocument.findFirst({ where: { id: documentId, tenantId: args.tenantId, clientId: args.clientId, storagePath: { not: null }, contentSha256: args.documentSha256 }, select: { storagePath: true } })
  if (!document?.storagePath || !documentBytesMatchSha256(await readFile(document.storagePath), args.documentSha256)) return { kind: "not_ready", reason: "The agreement bytes failed their integrity check" }
  // Signing OTP (lib/signing-otp): bound to the AGREEMENT signer row (its
  // digest is the agreement's, set when issued) and these bytes; checked
  // here, spent first in the transaction.
  const signer = await prisma.dealSigner.findFirst({ where: { tenantId: args.tenantId, dealId: args.dealId, clientId: args.clientId, document: "AGREEMENT" }, select: { id: true } })
  if (!signer) return { kind: "not_found" }
  const otpBinding = { tenantId: args.tenantId, clientId: args.clientId, purpose: "DEAL_DOCUMENT" as const, subjectId: signer.id, documentSha256: args.documentSha256 }
  const otpRequired = await isSigningOtpRequired(args.tenantId, "portal")
  if (otpRequired) {
    const refusal = await checkSigningOtp(prisma, args.signingOtpChallengeId, otpBinding)
    if (refusal) return { kind: "signing_otp", reason: refusal }
  }
  const signedAt = new Date()
  try {
    await prisma.$transaction(async (tx) => {
      const signingOtp = otpRequired
        ? await consumeSigningOtp(tx, { ...otpBinding, challengeId: args.signingOtpChallengeId!, method: "portal", now: signedAt })
        : null
      // Claimed only while still unsigned and still these bytes: a concurrent
      // signature, or a re-issued agreement, makes one of these miss.
      const doc = await tx.clientDocument.updateMany({ where: { id: documentId, tenantId: args.tenantId, contentSha256: args.documentSha256, OR: [{ signatureState: null }, { signatureState: { not: "signed" } }] }, data: { verified: true, verifiedAt: signedAt, signatureState: "signed", signedAt, signedByIp: args.ip ?? null } })
      const application = await tx.loanApplication.updateMany({ where: { id: app.id, tenantId: args.tenantId, agreementSignedAt: null, agreementDocumentSha256: args.documentSha256 }, data: { agreementSignedAt: signedAt, agreementSignedMethod: "portal", agreementSignedByIp: args.ip ?? null, agreementSignatureData: args.signature } })
      if (doc.count !== 1 || application.count !== 1) throw new AgreementChangedWhileSigning()
      await tx.dealSigner.update({ where: { dealId_clientId_document: { dealId: args.dealId, clientId: args.clientId, document: "AGREEMENT" }, tenantId: args.tenantId }, data: {
        method: "E_SIGN", signedAt, signatureData: args.signature,
        signatureSha256: providerCountersignatureSha256(args.signature), signedByIp: args.ip ?? null,
      } })
      await logAuditStrict({ tenantId: args.tenantId, userEmail: args.clientEmail ?? undefined, action: AuditAction.AGREEMENT_SIGNED, entity: "LoanApplication", entityId: app.id, newValue: { assetFinanceDealId: args.dealId, documentSha256: args.documentSha256, method: "portal", actorClientId: args.clientId, ...(signingOtp ? { signingOtp } : {}) } }, tx)
    })
  } catch (error) {
    if (error instanceof SigningOtpRefusedError) return { kind: "signing_otp", reason: error.reason }
    if (error instanceof AgreementChangedWhileSigning) return { kind: "not_ready", reason: "The agreement was signed or changed while you were signing" }
    throw error
  }
  return { kind: "done" }
}

class AgreementChangedWhileSigning extends Error {}

export async function countersignAssetNcaAgreement(actor: { tenantId: string; userId: string; userEmail: string }, dealId: string, signature: string): Promise<AgreementResult> {
  const deal = await prisma.assetFinanceDeal.findFirst({ where: { id: dealId, tenantId: actor.tenantId }, select: { clientId: true, application: { select: { id: true, status: true, agreementDocumentSha256: true, agreementSignedAt: true, agreementSignedMethod: true, agreementSignatureData: true, agreementCountersignedAt: true } } } })
  if (!deal || !deal.clientId) return { kind: "not_found" }
  const app = deal.application
  if (app.status !== "APPROVED" || !app.agreementDocumentSha256 || !app.agreementSignedAt || app.agreementSignedMethod !== "portal" || !app.agreementSignatureData || app.agreementCountersignedAt) return { kind: "not_ready", reason: "The consumer-signed agreement is not ready for countersignature" }
  const user = await prisma.user.findFirst({ where: { id: actor.userId, tenantId: actor.tenantId, active: true }, select: { name: true, email: true } })
  if (!user) return { kind: "not_ready", reason: "The countersigning user is not active" }
  const countersignedAt = new Date()
  const providerName = user.name?.trim() || user.email
  const signatureSha256 = providerCountersignatureSha256(signature)
  const envelopeSha256 = providerCountersignatureEnvelopeSha256({
    tenantId: actor.tenantId, applicationId: app.id, clientId: deal.clientId, documentSha256: app.agreementDocumentSha256,
    consumerSignedAt: app.agreementSignedAt, consumerSignedMethod: "portal", consumerSignerId: deal.clientId,
    consumerSignatureSha256: providerCountersignatureSha256(app.agreementSignatureData), providerCountersignedAt: countersignedAt,
    providerSignerId: actor.userId, providerSignerName: providerName, providerSignerEmail: user.email, providerSignatureSha256: signatureSha256,
  })
  await prisma.$transaction(async (tx) => {
    await tx.loanApplication.update({ where: { id: app.id, tenantId: actor.tenantId }, data: {
      agreementCountersignedAt: countersignedAt, agreementCountersignedById: actor.userId, agreementCountersignedByName: providerName,
      agreementCountersignedByEmail: user.email, agreementCountersignatureData: signature, agreementCountersignatureSha256: signatureSha256,
      agreementCountersignatureEnvelopeSha256: envelopeSha256, agreementCountersignedDocumentSha256: app.agreementDocumentSha256,
    } })
    const contracted = await tx.assetFinanceDeal.updateMany({ where: { id: dealId, tenantId: actor.tenantId, status: "APPROVED" }, data: { status: "CONTRACTED" } })
    if (contracted.count !== 1) throw new Error("asset_nca_deal_changed")
    await createPayoutChecklist(tx, actor.tenantId, dealId)
    await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail, action: AuditAction.AGREEMENT_PROVIDER_COUNTERSIGNED, entity: "LoanApplication", entityId: app.id, newValue: { assetFinanceDealId: dealId, documentSha256: app.agreementDocumentSha256, envelopeSha256 } }, tx)
  })
  return { kind: "done" }
}

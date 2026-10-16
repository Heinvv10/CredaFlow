/**
 * An APPROVED consumer application with an acknowledged PASQ, signed as far as
 * the caller asks, on a fresh tenant with two staff users: `officerId` (the
 * approver) and `colleagueId`. Rows are not cleaned up — signed evidence is
 * immutable. Used by the RUN_*_IT suites that exercise the payout and
 * countersign triggers.
 */
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/prisma"
import {
  providerCountersignatureEnvelopeSha256,
  providerCountersignatureSha256,
} from "@/lib/compliance/provider-countersign"
import { calculateLoan } from "@/lib/loan-calculator"
import { createAffordabilityCalculatorEvidence } from "@/lib/affordability/snapshot"
import { CREDIT_LIFE_DISCLOSURE_VERSION } from "@/lib/insurance/credit-life-election"
import { createCreditLifeDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import { createPasqEvidence } from "@/lib/compliance/pasq"

export type Signing = "countersigned" | "unsigned" | "consumer_only"
export type Staff = "officer" | "colleague"

export interface ApprovedApplicationOptions {
  signing: Signing
  /** "portal" (default) or an in-branch signature witnessed by this staff user. */
  consumerSignedBy?: "portal" | { branchWitness: Staff }
  /** Who countersigns when `signing` is "countersigned" (default the officer). */
  countersignedBy?: Staff
  /** Writes a TenantConfig row with this setting; omitted = no config row. */
  requireSegregationOfDuties?: boolean
}

export interface ApprovedApplication {
  tenantId: string
  applicationId: string
  officerId: string
  colleagueId: string
  /** The countersignature fields as `staff` would record them, now. */
  countersignBy: (staff: Staff, at: Date) => Record<string, string | Date>
}

export async function createApprovedApplication(options: ApprovedApplicationOptions): Promise<ApprovedApplication> {
  const { signing } = options
  const token = randomUUID().replaceAll("-", "")
  const tenantId = `tenant_disburse_sig_${token}`
  const clientId = `client_disburse_sig_${token}`
  const productId = `product_disburse_sig_${token}`
  const applicationId = `application_disburse_sig_${token}`
  const pasqDocumentId = `pasq_disburse_sig_${token}`
  const staff = {
    officer: { id: `officer_disburse_sig_${token}`, name: "Synthetic Officer", email: `disburse-sig-officer-${token}@example.invalid` },
    colleague: { id: `colleague_disburse_sig_${token}`, name: "Synthetic Colleague", email: `disburse-sig-colleague-${token}@example.invalid` },
  }
  const pasqSha256 = "a".repeat(64)
  const agreementSha256 = "c".repeat(64)
  const generatedAt = new Date("2026-07-24T08:00:00.000Z")
  const signedAt = new Date("2026-07-24T08:05:00.000Z")
  const countersignedAt = new Date("2026-07-24T08:10:00.000Z")
  const consumerSignatureData = "data:image/png;base64,Y29uc3VtZXI="
  const providerSignatureData = "Synthetic Officer"
  const branchWitness = typeof options.consumerSignedBy === "object" ? staff[options.consumerSignedBy.branchWitness] : null
  const consumerSignedMethod = branchWitness ? "branch" : "portal"
  const creditLife = {
    version: "credit-life-election-v1" as const,
    election: "DECLINED" as const,
    principalCents: 500_000,
    termDays: 30,
    monthlyPremiumCents: 2_250,
    productId: `credit-life-${token}`,
    productName: "Synthetic Credit Life",
    insurerId: `insurer-${token}`,
    insurerName: "Synthetic Insurer",
  }
  const disclosureSha256 = createCreditLifeDisclosureSha256(creditLife)
  const pasqEvidence = createPasqEvidence({
    tenantId,
    applicationId,
    clientId,
    productId,
    termDays: 30,
    generatedAt,
    calculator: createAffordabilityCalculatorEvidence(calculateLoan({
      principal: 500_000,
      termDays: 30,
      productType: "MICRO",
      interestRatePm: 0.05,
      interestModel: "DAILY_ACCRUAL",
      initiationFeeModel: "FLAT_PCT",
      initiationFeePct: 0,
      initiationFeeMax: 0,
      monthlyServiceFee: 0,
      initiationFeePayment: "DEFERRED",
    }, generatedAt), generatedAt),
    creditLife: {
      election: creditLife.election,
      productId: creditLife.productId,
      productName: creditLife.productName,
      insurerId: creditLife.insurerId,
      insurerName: creditLife.insurerName,
      monthlyPremiumCents: creditLife.monthlyPremiumCents,
      disclosureVersion: CREDIT_LIFE_DISCLOSURE_VERSION,
      disclosureSha256,
    },
  })

  const countersignBy = (who: Staff, at: Date) => {
    const signer = staff[who]
    const providerSignatureSha256 = providerCountersignatureSha256(providerSignatureData)
    return {
      agreementCountersignedAt: at,
      agreementCountersignedById: signer.id,
      agreementCountersignedByName: signer.name,
      agreementCountersignedByEmail: signer.email,
      agreementCountersignatureData: providerSignatureData,
      agreementCountersignatureSha256: providerSignatureSha256,
      agreementCountersignatureEnvelopeSha256: providerCountersignatureEnvelopeSha256({
        tenantId,
        applicationId,
        clientId,
        documentSha256: agreementSha256,
        consumerSignedAt: signedAt,
        consumerSignedMethod,
        consumerSignerId: branchWitness?.id ?? clientId,
        consumerSignatureSha256: providerCountersignatureSha256(consumerSignatureData),
        providerCountersignedAt: at,
        providerSignerId: signer.id,
        providerSignerName: signer.name,
        providerSignerEmail: signer.email,
        providerSignatureSha256,
      }),
      agreementCountersignedDocumentSha256: agreementSha256,
    }
  }

  const consumerSignature = signing !== "unsigned"
    ? {
        agreementGeneratedAt: generatedAt,
        agreementDocumentId: `agreement-${applicationId}`,
        agreementDocumentSha256: agreementSha256,
        agreementSignedAt: signedAt,
        agreementSignedMethod: consumerSignedMethod,
        agreementSignedByUserId: branchWitness?.id ?? null,
        agreementSignatureData: consumerSignatureData,
      }
    : {}
  const countersignature = signing === "countersigned"
    ? countersignBy(options.countersignedBy ?? "officer", countersignedAt)
    : {}

  await prisma.tenant.create({
    data: { id: tenantId, slug: `disburse-sig-${token}`, name: "Disbursement signature guard" },
  })
  if (options.requireSegregationOfDuties !== undefined) {
    await prisma.tenantConfig.create({
      data: { tenantId, requireSegregationOfDuties: options.requireSegregationOfDuties },
    })
  }
  for (const user of Object.values(staff)) {
    await prisma.user.create({
      data: { id: user.id, tenantId, email: user.email, password: "not-a-real-login", name: user.name, role: "LOAN_ADMIN" },
    })
  }
  await prisma.loanProduct.create({
    data: {
      id: productId,
      tenantId,
      code: `DSIG-${token}`,
      name: "Disbursement signature guard loan",
      productType: "MICRO",
      minAmount: 100_000,
      maxAmount: 1_000_000,
      minTermDays: 1,
      maxTermDays: 365,
      interestRatePm: 0.05,
      interestModel: "DAILY_ACCRUAL",
    },
  })
  await prisma.insurer.create({
    data: { id: creditLife.insurerId, tenantId, name: creditLife.insurerName, active: true },
  })
  await prisma.insuranceProduct.create({
    data: {
      id: creditLife.productId,
      tenantId,
      code: `CL-DSIG-${token}`,
      name: creditLife.productName,
      type: "CREDIT_LIFE",
      premiumAmount: creditLife.monthlyPremiumCents / 100,
      sumAssured: creditLife.principalCents / 100,
      active: true,
      insurerId: creditLife.insurerId,
    },
  })
  await prisma.client.create({
    data: {
      id: clientId,
      tenantId,
      reference: `CLIENT-DSIG-${token}`,
      idNumber: `DISBURSE-SIG-ID-${token}`,
      firstName: "Synthetic",
      lastName: "Borrower",
      email: `disburse-sig-${token}@example.invalid`,
      phone: "+27820000000",
    },
  })
  await prisma.clientDocument.create({
    data: {
      id: pasqDocumentId,
      tenantId,
      clientId,
      docType: "FORM_20_PRE_AGREEMENT",
      fileUrl: `/api/applications/${applicationId}/pasq`,
      fileName: `pasq-${applicationId}.pdf`,
      fileSize: 4096,
      mimeType: "application/pdf",
      storagePath: `/tmp/pasq-${applicationId}.pdf`,
      contentSha256: pasqSha256,
      extractionStatus: "skipped",
    },
  })
  await prisma.loanApplication.create({
    data: {
      id: applicationId,
      tenantId,
      reference: `APP-DSIG-${token}`,
      clientId,
      productId,
      appliedAmount: 500_000,
      appliedTermDays: 30,
      status: "APPROVED",
      repaymentMethod: "EFT",
      approvedAt: countersignedAt,
      approvedById: staff.officer.id,
      creditLifeElection: creditLife.election,
      creditLifeProductId: creditLife.productId,
      creditLifeProductName: creditLife.productName,
      creditLifeInsurerId: creditLife.insurerId,
      creditLifeInsurerName: creditLife.insurerName,
      creditLifeMonthlyPremiumCents: creditLife.monthlyPremiumCents,
      creditLifeDisclosureVersion: creditLife.version,
      creditLifeDisclosureSha256: disclosureSha256,
      creditLifeDisclosureAcknowledgedAt: new Date("2026-07-24T07:55:00.000Z"),
      creditLifeDisclosureAcknowledgedBy: clientId,
      pasqVersion: pasqEvidence.version,
      pasqGeneratedAt: generatedAt,
      pasqDocumentId,
      pasqDocumentSha256: pasqSha256,
      pasqEvidence,
      pasqEvidenceSha256: pasqEvidence.evidenceSha256,
      pasqAcknowledgedAt: signedAt,
      pasqAcknowledgedBy: clientId,
      pasqAcknowledgedSha256: pasqSha256,
      approvedPasqDocumentSha256: pasqSha256,
      ...consumerSignature,
      ...countersignature,
    },
  })
  return { tenantId, applicationId, officerId: staff.officer.id, colleagueId: staff.colleague.id, countersignBy }
}

/** Thrown inside a transaction to roll back before the deferred loan invariant. */
export const rollback = new Error("intentional rollback before the deferred loan invariant")

/**
 * Attempt APPROVED -> DISBURSED as `disbursedById` and roll back. Rolling back
 * keeps the deferred Loan/disbursement commit check out of it, so a refusal
 * here comes from an immediate trigger, and an admitted transition surfaces as
 * `rollback`.
 */
export function disburse(
  scenario: { tenantId: string; applicationId: string },
  disbursedById: string | null,
) {
  return prisma.$transaction(async (tx) => {
    await tx.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: { status: "DISBURSED", disbursedAt: new Date("2026-07-24T08:15:00.000Z"), disbursedById },
    })
    throw rollback
  })
}

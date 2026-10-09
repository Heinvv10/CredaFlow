/**
 * Run only against a disposable, fully migrated PostgreSQL database:
 *
 *   RUN_DISBURSEMENT_SIGNATURE_GUARD_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/disbursement/disbursement-signature-guard.integration.test.ts
 *
 * The outage disbursement exception was the one path that let an application
 * reach DISBURSED without signed agreement evidence. It is gone; this proves
 * the database still refuses the transition for an unsigned agreement.
 */
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
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

const suite = process.env.RUN_DISBURSEMENT_SIGNATURE_GUARD_IT === "1"
  ? describe
  : describe.skip

type Signing = "countersigned" | "unsigned" | "consumer_only"

/** An APPROVED application with acknowledged PASQ, signed as far as `signing` says. */
async function createApprovedApplication(signing: Signing) {
  const token = randomUUID().replaceAll("-", "")
  const tenantId = `tenant_disburse_sig_${token}`
  const clientId = `client_disburse_sig_${token}`
  const productId = `product_disburse_sig_${token}`
  const applicationId = `application_disburse_sig_${token}`
  const officerId = `officer_disburse_sig_${token}`
  const pasqDocumentId = `pasq_disburse_sig_${token}`
  const officerEmail = `disburse-sig-officer-${token}@example.invalid`
  const pasqSha256 = "a".repeat(64)
  const agreementSha256 = "c".repeat(64)
  const generatedAt = new Date("2026-07-24T08:00:00.000Z")
  const signedAt = new Date("2026-07-24T08:05:00.000Z")
  const countersignedAt = new Date("2026-07-24T08:10:00.000Z")
  const consumerSignatureData = "data:image/png;base64,Y29uc3VtZXI="
  const providerSignatureData = "Synthetic Officer"
  const providerSignatureSha256 = providerCountersignatureSha256(providerSignatureData)
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

  const consumerSigned = signing !== "unsigned"
  const consumerSignature = consumerSigned
    ? {
        agreementGeneratedAt: generatedAt,
        agreementDocumentId: `agreement-${applicationId}`,
        agreementDocumentSha256: agreementSha256,
        agreementSignedAt: signedAt,
        agreementSignedMethod: "portal",
        agreementSignatureData: consumerSignatureData,
      }
    : {}
  const countersignature = signing === "countersigned"
    ? {
        agreementCountersignedAt: countersignedAt,
        agreementCountersignedById: officerId,
        agreementCountersignedByName: "Synthetic Officer",
        agreementCountersignedByEmail: officerEmail,
        agreementCountersignatureData: providerSignatureData,
        agreementCountersignatureSha256: providerSignatureSha256,
        agreementCountersignatureEnvelopeSha256: providerCountersignatureEnvelopeSha256({
          tenantId,
          applicationId,
          clientId,
          documentSha256: agreementSha256,
          consumerSignedAt: signedAt,
          consumerSignedMethod: "portal",
          consumerSignerId: clientId,
          consumerSignatureSha256: providerCountersignatureSha256(consumerSignatureData),
          providerCountersignedAt: countersignedAt,
          providerSignerId: officerId,
          providerSignerName: "Synthetic Officer",
          providerSignerEmail: officerEmail,
          providerSignatureSha256,
        }),
        agreementCountersignedDocumentSha256: agreementSha256,
      }
    : {}

  await prisma.tenant.create({
    data: { id: tenantId, slug: `disburse-sig-${token}`, name: "Disbursement signature guard" },
  })
  await prisma.user.create({
    data: {
      id: officerId,
      tenantId,
      email: officerEmail,
      password: "not-a-real-login",
      name: "Synthetic Officer",
      role: "LOAN_ADMIN",
    },
  })
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
      approvedById: officerId,
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
  return { tenantId, applicationId }
}

const rollback = new Error("intentional rollback before the deferred loan invariant")

/**
 * Attempt APPROVED -> DISBURSED and roll back. Rolling back keeps the deferred
 * Loan/disbursement commit check out of it, so a refusal here comes from the
 * immediate signature gate, and an admitted transition surfaces as `rollback`.
 */
function disburse(scenario: { tenantId: string; applicationId: string }) {
  return prisma.$transaction(async (tx) => {
    await tx.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: { status: "DISBURSED", disbursedAt: new Date("2026-07-24T08:15:00.000Z") },
    })
    throw rollback
  })
}

suite("disbursement signature gate after the outage exception's removal", () => {
  it("admits a fully countersigned agreement (control)", async () => {
    await expect(disburse(await createApprovedApplication("countersigned"))).rejects.toBe(rollback)
  })

  it.each(["unsigned", "consumer_only"] as const)(
    "refuses DISBURSED for a %s agreement",
    async (signing) => {
      await expect(disburse(await createApprovedApplication(signing))).rejects.toThrow(
        /requires provider countersign evidence bound to the exact tenant, consumer signature and agreement/,
      )
    },
  )

  it("leaves no outage exception object in the database", async () => {
    const [objects] = await prisma.$queryRaw<Array<{
      functions: number
      triggers: number
      constraints: number
      columns: number
    }>>`
      SELECT
        (SELECT COUNT(*)::INT FROM pg_proc
          WHERE proname ILIKE '%outage%' OR prosrc ILIKE '%OutageDisbursement%') AS functions,
        (SELECT COUNT(*)::INT FROM pg_trigger WHERE tgname ILIKE '%outage%') AS triggers,
        (SELECT COUNT(*)::INT FROM pg_constraint
          WHERE pg_get_constraintdef(oid) ILIKE '%outage%') AS constraints,
        (SELECT COUNT(*)::INT FROM information_schema.columns
          WHERE column_name = 'disbursementExceptionId') AS columns
    `
    expect(objects).toEqual({ functions: 0, triggers: 0, constraints: 0, columns: 0 })
  })
})

import { CREDIT_LIFE_DISCLOSURE_VERSION } from "@/lib/insurance/credit-life-election"
/**
 * Run only against a disposable, fully migrated PostgreSQL database:
 *
 *   RUN_PASQ_V3_BILLING_IT=1 DATABASE_URL=postgresql://... \
 *     pnpm vitest run lib/compliance/pasq-v3-billing-migration.integration.test.ts
 */
import { createHash, randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { createCreditLifeDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import { createPasqEvidence } from "@/lib/compliance/pasq"
import {
  providerCountersignatureEnvelopeSha256,
  providerCountersignatureSha256,
} from "@/lib/compliance/provider-countersign"
import {
  createApplicationContractFixture,
  createSignedDebitMandateFixture,
} from "@/lib/compliance/signed-debit-mandate.integration-fixture"
import {
  affordabilityCalculatorFingerprint,
  affordabilityContractFingerprint,
  readAffordabilitySnapshotStore,
  returnAffordabilityToReview,
} from "@/lib/affordability/snapshot"
import {
  debitMandateEvidenceSha256,
  readDebitMandateEvidence,
  type DebitMandateEvidence,
} from "@/lib/compliance/debit-mandate"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import { runWithTenant } from "@/lib/tenant-scope"

const suite = process.env.RUN_PASQ_V3_BILLING_IT === "1"
  ? describe
  : describe.skip

type FixtureContract = ReturnType<
  typeof createApplicationContractFixture
>["affordabilityResult"]["contract"]

type ContractInstallOptions = {
  agreementGeneratedAt?: Date
  quoteValidUntilDate?: string
  firstDueDateOffsetMs?: number
}

function rebaseContractForDatabaseTest(
  contract: FixtureContract,
  agreementGeneratedAt: Date,
  options: ContractInstallOptions,
): FixtureContract {
  if (
    typeof contract.quotePresentedAt !== "string"
    || typeof contract.quoteValidUntilDate !== "string"
  ) {
    throw new Error("PASQ v3 contract fixture requires quote dates")
  }
  const {
    pricingFingerprint: _pricingFingerprint,
    contractFingerprint: _contractFingerprint,
    ...unhashedCalculator
  } = contract.calculator
  const agreementOffsetMs =
    agreementGeneratedAt.getTime()
    - new Date(contract.quotePresentedAt).getTime()
  const calculatorForHash = {
    ...unhashedCalculator,
    startDate: agreementGeneratedAt.toISOString(),
    schedule: unhashedCalculator.schedule.map((item, index) => ({
      ...item,
      dueDate: new Date(
        new Date(item.dueDate).getTime()
        + agreementOffsetMs
        + (index === 0 ? options.firstDueDateOffsetMs ?? 0 : 0),
      ).toISOString(),
    })),
  }
  const calculator = {
    ...calculatorForHash,
    pricingFingerprint:
      affordabilityCalculatorFingerprint(calculatorForHash),
    contractFingerprint:
      affordabilityContractFingerprint(calculatorForHash),
  }
  const rebased = {
    ...contract,
    establishedAt: agreementGeneratedAt.toISOString(),
    quoteValidUntilDate:
      options.quoteValidUntilDate ?? contract.quoteValidUntilDate,
    calculator,
  }
  return {
    ...rebased,
    fingerprint: createHash("sha256").update(JSON.stringify([
      rebased.version,
      rebased.establishedAt,
      rebased.acceptedPasqDocumentSha256,
      rebased.acceptedPasqContractFingerprint,
      rebased.quotePresentedAt,
      rebased.quoteValidUntilDate,
      rebased.approvalDecisionFingerprint,
      rebased.calculator.contractFingerprint,
    ])).digest("hex"),
  }
}

async function createApprovedPasqV3Application(
  label: string,
  election: "ACCEPTED" | "DECLINED" = "ACCEPTED",
  withDisbursementAgreement = true,
  applicationInitiationFeePayment: "DEFERRED" | "UPFRONT" = "DEFERRED",
  seedPriorAffordabilityHistory = false,
  tamperFinalEvidence: "approval_hash" | "contract_hash" | null = null,
  contractInstallOptions: ContractInstallOptions = {},
  // DEBIT_ORDER by default because every scenario here signs a debit mandate.
  // NOT nullable: `LoanApplication_repayment_method_lifecycle` requires a
  // method from APPROVED onward, so a null one cannot reach the states these
  // tests exercise at all.
  repaymentMethod: "EFT" | "DEBIT_ORDER" = "DEBIT_ORDER",
) {
  const token = randomUUID().replaceAll("-", "")
  const tenantId = `tenant_pasq_v3_${label}_${token}`
  const clientId = `client_pasq_v3_${label}_${token}`
  const productId = `product_pasq_v3_${label}_${token}`
  const applicationId = `application_pasq_v3_${label}_${token}`
  const officerId = `officer_pasq_v3_${label}_${token}`
  const pasqDocumentId = `pasq_document_v3_${label}_${token}`
  const pasqDocumentSha256 = "a".repeat(64)
  const agreementDocumentId = `agreement_document_v3_${label}_${token}`
  const agreementDocumentSha256 = "b".repeat(64)
  const quotePresentedAt = new Date("2026-07-24T08:00:00.000Z")
  const generatedAt = contractInstallOptions.agreementGeneratedAt
    ?? quotePresentedAt
  const signedAt = new Date(generatedAt.getTime() + 6 * 60_000)
  const countersignedAt = new Date(generatedAt.getTime() + 8 * 60_000)
  const consumerSignatureData = "data:image/png;base64,Y29uc3VtZXI="
  const providerSignatureData = "Synthetic Officer"
  const providerSignerName = "Synthetic Officer"
  const providerSignerEmail =
    `pasq-v3-officer-${label}-${token}@example.invalid`
  const providerSignatureSha256 =
    providerCountersignatureSha256(providerSignatureData)
  const consumerSignatureSha256 =
    providerCountersignatureSha256(consumerSignatureData)
  const providerEnvelopeSha256 = providerCountersignatureEnvelopeSha256({
    tenantId,
    applicationId,
    clientId,
    documentSha256: agreementDocumentSha256,
    consumerSignedAt: signedAt,
    consumerSignedMethod: "portal",
    consumerSignerId: clientId,
    consumerSignatureSha256,
    providerCountersignedAt: countersignedAt,
    providerSignerId: officerId,
    providerSignerName,
    providerSignerEmail,
    providerSignatureSha256,
  })
  const pricing = {
    principal: 500_000,
    termDays: 30,
    productType: "MICRO",
    interestRatePm: 0.05,
    interestModel: "DAILY_ACCRUAL",
    initiationFeeModel: "FLAT_PCT",
    initiationFeePct: 0,
    initiationFeeMax: 0,
    monthlyServiceFee: 6_900,
    initiationFeePayment: "DEFERRED",
  } as const
  const { calculation, affordabilityResult } =
    createApplicationContractFixture({
      applicationId,
      productId,
      officerId,
      pricing,
      quotePresentedAt,
      agreementEstablishedAt: quotePresentedAt,
      acceptedPasqDocumentSha256: pasqDocumentSha256,
    })
  const priorOfficerId = `prior_officer_pasq_v3_${label}_${token}`
  const { affordabilityResult: priorAffordabilityResult } =
    createApplicationContractFixture({
      applicationId,
      productId,
      officerId: priorOfficerId,
      pricing,
      quotePresentedAt,
      agreementEstablishedAt: quotePresentedAt,
      acceptedPasqDocumentSha256: pasqDocumentSha256,
    })
  const priorApproval = priorAffordabilityResult.approval
  const priorContract = rebaseContractForDatabaseTest(
    priorAffordabilityResult.contract,
    generatedAt,
    contractInstallOptions,
  )
  const preservedReviewMarker = {
    cycle: "prior-review",
    retained: true,
  }
  const initialAffordabilityResult = seedPriorAffordabilityHistory
    ? {
        schemaVersion: affordabilityResult.schemaVersion,
        preservedReviewMarker,
      }
    : {
        schemaVersion: affordabilityResult.schemaVersion,
      }
  const disclosure = {
    version: "credit-life-election-v1" as const,
    election,
    principalCents: calculation.principal,
    termDays: 30,
    monthlyPremiumCents: 2_250,
    productId: `credit-life-${token}`,
    productName: "Synthetic Credit Life",
    insurerId: `insurer-${token}`,
    insurerName: "Synthetic Insurer",
  }
  const pasqEvidence = createPasqEvidence({
    tenantId,
    applicationId,
    clientId,
    productId,
    termDays: 30,
    generatedAt: quotePresentedAt,
    calculator: affordabilityResult.approval.calculator,
    creditLife: {
      election,
      productId: disclosure.productId,
      productName: disclosure.productName,
      insurerId: disclosure.insurerId,
      insurerName: disclosure.insurerName,
      monthlyPremiumCents: disclosure.monthlyPremiumCents,
      disclosureVersion: CREDIT_LIFE_DISCLOSURE_VERSION,
      disclosureSha256: createCreditLifeDisclosureSha256(disclosure),
    },
  })

  await prisma.tenant.create({
    data: {
      id: tenantId,
      slug: `pasq-v3-${label}-${token}`,
      name: `PASQ v3 ${label}`,
    },
  })
  await prisma.user.create({
    data: {
      id: officerId,
      tenantId,
      email: providerSignerEmail,
      password: "not-a-real-login",
      name: providerSignerName,
      role: "LOAN_ADMIN",
    },
  })
  if (seedPriorAffordabilityHistory) {
    await prisma.user.create({
      data: {
        id: priorOfficerId,
        tenantId,
        email:
          `pasq-v3-prior-officer-${label}-${token}@example.invalid`,
        password: "not-a-real-login",
        name: "Synthetic Prior Officer",
        role: "LOAN_ADMIN",
      },
    })
  }
  await prisma.loanProduct.create({
    data: {
      id: productId,
      tenantId,
      code: `PV3-${label}-${token}`,
      name: `PASQ v3 ${label}`,
      productType: "MICRO",
      minAmount: 100_000,
      maxAmount: 1_000_000,
      minTermDays: 1,
      maxTermDays: 365,
      interestRatePm: 0.05,
      interestModel: "DAILY_ACCRUAL",
      monthlyServiceFee: 6_900,
    },
  })
  await prisma.insurer.create({
    data: {
      id: disclosure.insurerId,
      tenantId,
      name: disclosure.insurerName,
      active: true,
    },
  })
  await prisma.insuranceProduct.create({
    data: {
      id: disclosure.productId,
      tenantId,
      code: `CL-PV3-${label}-${token}`,
      name: disclosure.productName,
      type: "CREDIT_LIFE",
      premiumAmount: disclosure.monthlyPremiumCents / 100,
      sumAssured: calculation.principal / 100,
      active: true,
      insurerId: disclosure.insurerId,
      commissionRate: 0,
    },
  })
  await prisma.client.create({
    data: {
      id: clientId,
      tenantId,
      reference: `CLIENT-PV3-${label}-${token}`,
      idNumber: `PASQ-V3-ID-${label}-${token}`,
      firstName: "Synthetic",
      lastName: label,
      email: `pasq-v3-${label}-${token}@example.invalid`,
      phone: "+27820000000",
      grossMonthlyIncome: 2_000_000,
      monthlyIncome: 2_000_000,
      monthlyExpenses: 800_000,
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
      contentSha256: pasqDocumentSha256,
      extractionStatus: "skipped",
    },
  })
  if (withDisbursementAgreement) {
    await prisma.clientDocument.create({
      data: {
        id: agreementDocumentId,
        tenantId,
        clientId,
        docType: "CREDIT_AGREEMENT",
        fileUrl: `/api/applications/${applicationId}/agreement`,
        fileName: `credit-agreement-${applicationId}.pdf`,
        fileSize: 4096,
        mimeType: "application/pdf",
        storagePath: `/tmp/credit-agreement-${applicationId}.pdf`,
        contentSha256: agreementDocumentSha256,
        extractionStatus: "skipped",
        verified: true,
        verifiedAt: signedAt,
        verifiedById: null,
        signatureState: "signed",
        signedAt,
      },
    })
  }
  await prisma.loanApplication.create({
    data: {
      id: applicationId,
      tenantId,
      reference: `APP-PV3-${label}-${token}`,
      clientId,
      productId,
      appliedAmount: calculation.principal,
      appliedTermDays: 30,
      initiationFeePayment: applicationInitiationFeePayment,
      // Deliberately absent: the same constraint forbids a method before
      // APPROVED. It is set by installApproval, on the transition itself.
      status: "UNDER_REVIEW",
      assignedToId: officerId,
      affordabilityResult: initialAffordabilityResult,
      clientAffordabilityDeclaredAt:
        new Date("2026-07-24T07:50:00.000Z"),
      recklessLendingAssessed: true,
      recklessLendingAssessedById: officerId,
      recklessLendingAssessedAt:
        new Date("2026-07-24T08:09:00.000Z"),
      creditLifeElection: disclosure.election,
      creditLifeProductId: disclosure.productId,
      creditLifeProductName: disclosure.productName,
      creditLifeInsurerId: disclosure.insurerId,
      creditLifeInsurerName: disclosure.insurerName,
      creditLifeMonthlyPremiumCents: disclosure.monthlyPremiumCents,
      creditLifeDisclosureVersion: disclosure.version,
      creditLifeDisclosureSha256:
        createCreditLifeDisclosureSha256(disclosure),
      creditLifeDisclosureAcknowledgedAt:
        new Date("2026-07-24T07:55:00.000Z"),
      creditLifeDisclosureAcknowledgedBy: clientId,
      pasqVersion: pasqEvidence.version,
      pasqGeneratedAt: quotePresentedAt,
      pasqDocumentId,
      pasqDocumentSha256,
      pasqEvidence,
      pasqEvidenceSha256: pasqEvidence.evidenceSha256,
      pasqAcknowledgedAt: new Date("2026-07-24T08:05:00.000Z"),
      pasqAcknowledgedBy: clientId,
      pasqAcknowledgedSha256: pasqDocumentSha256,
    },
  })

  const installApproval = async (
    approval: typeof affordabilityResult.approval,
  ) => {
    const approvingOfficerId = approval.capturedById!
    const current = await prisma.loanApplication.findUniqueOrThrow({
      where: {
        id: applicationId,
        tenantId,
      },
      select: {
        affordabilityResult: true,
      },
    })
    return prisma.loanApplication.update({
      where: {
        id: applicationId,
        tenantId,
      },
      data: {
        status: "APPROVED",
        repaymentMethod,
        approvedAt: new Date(approval.capturedAt),
        approvedById: approvingOfficerId,
        approvedAmount: calculation.principal,
        approvedTermDays: 30,
        approvedRate: 0.05,
        decisionReason:
          "Synthetic approval for database authority testing",
        totalExistingDebt: approval.inputs.declaredDebtCents,
        netDisposableIncome:
          approval.outcome.netDisposableIncomeCents,
        affordabilityNDI: approval.outcome.ndiAfterLoanCents,
        affordabilityResult:
          {
            ...readAffordabilitySnapshotStore(
              current.affordabilityResult,
            ),
            approval,
          } as unknown as Prisma.InputJsonValue,
        clientAffordabilityDeclaredAt:
          new Date("2026-07-24T07:50:00.000Z"),
        recklessLendingAssessed: true,
        recklessLendingAssessedById: approvingOfficerId,
        recklessLendingAssessedAt:
          new Date("2026-07-24T08:09:00.000Z"),
        creditLifeElection: disclosure.election,
        creditLifeProductId: disclosure.productId,
        creditLifeProductName: disclosure.productName,
        creditLifeInsurerId: disclosure.insurerId,
        creditLifeInsurerName: disclosure.insurerName,
        creditLifeMonthlyPremiumCents: disclosure.monthlyPremiumCents,
        creditLifeDisclosureVersion: disclosure.version,
        creditLifeDisclosureSha256:
          createCreditLifeDisclosureSha256(disclosure),
        creditLifeDisclosureAcknowledgedAt:
          new Date("2026-07-24T07:55:00.000Z"),
        creditLifeDisclosureAcknowledgedBy: clientId,
        pasqVersion: pasqEvidence.version,
        pasqGeneratedAt: quotePresentedAt,
        pasqDocumentId,
        pasqDocumentSha256,
        pasqEvidence,
        pasqEvidenceSha256: pasqEvidence.evidenceSha256,
        pasqAcknowledgedAt: new Date("2026-07-24T08:05:00.000Z"),
        pasqAcknowledgedBy: clientId,
        pasqAcknowledgedSha256: pasqDocumentSha256,
        approvedPasqDocumentSha256: pasqDocumentSha256,
      },
      select: {
        affordabilityResult: true,
      },
    })
  }

  const installContract = async (
    contract: typeof affordabilityResult.contract,
    currentAffordabilityResult: unknown,
  ) => prisma.loanApplication.update({
    where: {
      id: applicationId,
      tenantId,
    },
    data: {
      agreementGeneratedAt: generatedAt,
      agreementDocumentId,
      agreementDocumentSha256,
      affordabilityResult: {
        ...readAffordabilitySnapshotStore(currentAffordabilityResult),
        contract,
      } as unknown as Prisma.InputJsonValue,
    },
    select: {
      affordabilityResult: true,
    },
  })

  if (seedPriorAffordabilityHistory) {
    const priorApproved = await installApproval(priorApproval)
    const priorContracted = await installContract(
      priorContract,
      priorApproved.affordabilityResult,
    )
    await prisma.loanApplication.update({
      where: {
        id: applicationId,
        tenantId,
      },
      data: signedMandateReturnToReviewData({
        officerId,
        affordabilityResult: priorContracted.affordabilityResult,
      }),
    })
  }

  const finalApproval = tamperFinalEvidence === "approval_hash"
    ? {
        ...affordabilityResult.approval,
        decisionFingerprint: "0".repeat(64),
      }
    : affordabilityResult.approval
  const approved = await installApproval(finalApproval)
  let finalAffordabilityResult: unknown = approved.affordabilityResult
  if (withDisbursementAgreement) {
    const rebasedFinalContract = rebaseContractForDatabaseTest(
      affordabilityResult.contract,
      generatedAt,
      contractInstallOptions,
    )
    const finalContract = tamperFinalEvidence === "contract_hash"
      ? {
          ...rebasedFinalContract,
          fingerprint: "0".repeat(64),
        }
      : rebasedFinalContract
    const contracted = await installContract(
      finalContract,
      approved.affordabilityResult,
    )
    finalAffordabilityResult = contracted.affordabilityResult
    // `LoanApplication_eft_has_no_signed_debit_authority` forbids every signed
    // mandate field on an EFT application, so an EFT scenario must carry no
    // mandate at all — not merely an unused one.
    const debitMandate = repaymentMethod === "DEBIT_ORDER"
      ? await createSignedDebitMandateFixture({
          tenantId,
          clientId,
          applicationId,
          agreementSignedAt: signedAt,
          affordabilityResult: finalAffordabilityResult,
          pasqEvidence,
        })
      : {}
    await prisma.loanApplication.update({
      where: {
        id: applicationId,
        tenantId,
      },
      data: {
        agreementSignedAt: signedAt,
        agreementSignedMethod: "portal",
        agreementSignatureData: consumerSignatureData,
        agreementCountersignedAt: countersignedAt,
        agreementCountersignedById: officerId,
        agreementCountersignedByName: providerSignerName,
        agreementCountersignedByEmail: providerSignerEmail,
        agreementCountersignatureData: providerSignatureData,
        agreementCountersignatureSha256: providerSignatureSha256,
        agreementCountersignatureEnvelopeSha256: providerEnvelopeSha256,
        agreementCountersignedDocumentSha256: agreementDocumentSha256,
        ...debitMandate,
      },
    })
  }
  const insuranceProductId = disclosure.productId
  if (withDisbursementAgreement) {
    await prisma.complianceRecord.create({
      data: {
        tenantId,
        type: "AGREEMENT_ARTIFACT",
        referenceId: applicationId,
        status: "COMPLETED",
        completedAt: countersignedAt,
        data: {
          kind: "CREDIT_AGREEMENT_ARTIFACT",
          lifecycle: "COMPLETED",
          applicationId,
          documentId: agreementDocumentId,
          documentSha256: agreementDocumentSha256,
          storagePath: `/tmp/credit-agreement-${applicationId}.pdf`,
          fileName: `credit-agreement-${applicationId}.pdf`,
          fileSize: 4096,
          creditLifeAutoBundleEligible: election === "ACCEPTED",
        },
      },
    })
  }
  return {
    tenantId,
    clientId,
    productId,
    applicationId,
    officerId,
    calculation,
    pasqEvidence,
    agreementDocumentId,
    insuranceProductId,
    generatedAt,
    signedAt,
  }
}

async function bookLoan(
  scenario: Awaited<ReturnType<typeof createApprovedPasqV3Application>>,
  totalRepayableOffset = 0,
  // Whole SAST days the booked schedule is shifted BEYOND the agreement
  // offset, i.e. the payout lag. Only an EFT loan may carry a non-zero value;
  // for every other repayment method the trigger requires payout and agreement
  // to fall on the same SAST date, so the shift has nowhere to come from.
  payoutShiftDays = 0,
) {
  const loanId = `loan_${randomUUID().replaceAll("-", "")}`
  const agreementOffsetMs =
    scenario.generatedAt.getTime()
    - new Date(scenario.pasqEvidence.calculator.startDate).getTime()
  const agreementDueDate = (value: string) =>
    new Date(
      new Date(value).getTime()
      + agreementOffsetMs
      + payoutShiftDays * 86_400_000,
    )
  const maturityDate = agreementDueDate(
    scenario.pasqEvidence.billing.schedule.at(-1)!.dueDate,
  )
  await prisma.$transaction(async (tx) => {
    await tx.loan.create({
      data: {
        id: loanId,
        tenantId: scenario.tenantId,
        reference: `LN-PV3-${randomUUID()}`,
        applicationId: scenario.applicationId,
        clientId: scenario.clientId,
        productId: scenario.productId,
        principal: scenario.pasqEvidence.calculator.principalCents,
        totalInterest: scenario.pasqEvidence.calculator.totalInterestCents,
        initiationFee: scenario.pasqEvidence.calculator.initiationFeeCents,
        creditLifePremiums:
          scenario.pasqEvidence.creditLife.totalPremiumCents,
        totalRepayable:
          scenario.pasqEvidence.billing.totalRepayableCents
          + totalRepayableOffset,
        contractualTotalInterest:
          scenario.pasqEvidence.calculator.totalInterestCents,
        contractualTotalRepayable:
          scenario.pasqEvidence.billing.totalRepayableCents
          + totalRepayableOffset,
        outstandingPrincipal:
          scenario.pasqEvidence.calculator.principalCents,
        startDate: scenario.signedAt,
        maturityDate,
        nextPaymentDate: agreementDueDate(
          scenario.pasqEvidence.billing.schedule[0].dueDate,
        ),
        interestRatePm: 0.05,
        interestModel: "DAILY_ACCRUAL",
        monthlyServiceFee: 0,
        agreementDocId: scenario.agreementDocumentId,
      },
    })
    await tx.loanApplication.update({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      data: {
        status: "DISBURSED",
        disbursedAt: scenario.signedAt,
      },
    })
    await tx.repaymentSchedule.createMany({
      data: scenario.pasqEvidence.billing.schedule.map((item) => ({
        tenantId: scenario.tenantId,
        loanId,
        installmentNo: item.installmentNo,
        dueDate: agreementDueDate(item.dueDate),
        principalDue: item.principalDueCents,
        interestDue: item.interestDueCents,
        creditLifePremiumDue: item.creditLifePremiumDueCents,
        feesDue: item.feesDueCents,
        totalDue: item.totalDueCents,
      })),
    })
    if (
      scenario.pasqEvidence.creditLife.election === "ACCEPTED"
      && scenario.insuranceProductId
    ) {
      await tx.insurancePolicy.create({
        data: {
          tenantId: scenario.tenantId,
          policyNumber: `CL-PV3-${randomUUID()}`,
          clientId: scenario.clientId,
          type: "CREDIT_LIFE",
          status: "ACTIVE",
          premiumAmount:
            scenario.pasqEvidence.creditLife.monthlyPremiumCents / 100,
          sumAssured: scenario.pasqEvidence.calculator.principalCents / 100,
          linkedLoanId: loanId,
          startDate: scenario.signedAt,
          renewalDate: maturityDate,
          productId: scenario.insuranceProductId,
          policySource: "BUNDLED_CREDIT_AGREEMENT",
        },
      })
    }
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
  })
  return loanId
}

const alteredMandateTerms: Array<[
  string,
  (evidence: DebitMandateEvidence) => DebitMandateEvidence,
]> = [
  [
    "contract fingerprint",
    (evidence) => ({
      ...evidence,
      contractFingerprint: "0".repeat(64),
    }),
  ],
  [
    "first debit amount",
    (evidence) => ({
      ...evidence,
      terms: {
        ...evidence.terms,
        firstDebitAmountCents: evidence.terms.firstDebitAmountCents + 1,
      },
    }),
  ],
  [
    "payment frequency",
    (evidence) => ({
      ...evidence,
      terms: {
        ...evidence.terms,
        paymentFrequency: "MONTHLY",
        recurringDebitAmountCents: 1,
      },
    }),
  ],
  [
    "first debit date",
    (evidence) => ({
      ...evidence,
      terms: {
        ...evidence.terms,
        firstDebitDate: new Date(
          new Date(evidence.terms.firstDebitDate).getTime() + 86_400_000,
        ).toISOString(),
      },
    }),
  ],
  [
    "first-debit initiation fee",
    (evidence) => ({
      ...evidence,
      terms: {
        ...evidence.terms,
        firstDebitInitiationFeeCents:
          evidence.terms.firstDebitInitiationFeeCents + 1,
      },
    }),
  ],
]

function signedMandateReturnToReviewData(args: {
  officerId: string
  affordabilityResult: unknown
}): Prisma.LoanApplicationUncheckedUpdateInput {
  return {
    status: "UNDER_REVIEW",
    assignedToId: args.officerId,
    // Cleared with the rest of the approval: the lifecycle constraint forbids
    // a repayment method before APPROVED, so a return-to-review that kept it
    // would be rejected outright.
    repaymentMethod: null,
    approvedAt: null,
    approvedById: null,
    approvedAmount: null,
    approvedTermDays: null,
    approvedRate: null,
    decisionReason: null,
    affordabilityResult: returnAffordabilityToReview(
      args.affordabilityResult,
    ) as unknown as Prisma.InputJsonValue,
    bureauOverrideReason: null,
    bureauOverrideById: null,
    bureauOverrideAt: null,
    bureauReviewGeneration: randomUUID(),
    recklessLendingAssessed: false,
    recklessLendingAssessedById: null,
    recklessLendingAssessedAt: null,
    pasqVersion: null,
    pasqGeneratedAt: null,
    pasqDocumentId: null,
    pasqDocumentSha256: null,
    pasqEvidence: Prisma.DbNull,
    pasqEvidenceSha256: null,
    pasqAcknowledgedAt: null,
    pasqAcknowledgedBy: null,
    pasqAcknowledgedSha256: null,
    approvedPasqDocumentSha256: null,
    clientAffordabilityDeclaredAt: null,
    agreementGeneratedAt: null,
    agreementDocumentId: null,
    agreementDocumentSha256: null,
    agreementSignedAt: null,
    agreementSignedMethod: null,
    agreementSignedByIp: null,
    agreementSignedByUserId: null,
    agreementSignatureData: null,
    agreementCountersignedAt: null,
    agreementCountersignedById: null,
    agreementCountersignedByName: null,
    agreementCountersignedByEmail: null,
    agreementCountersignatureData: null,
    agreementCountersignatureSha256: null,
    agreementCountersignatureEnvelopeSha256: null,
    agreementCountersignedDocumentSha256: null,
    debitMandatePreparedAt: null,
    debitMandateReference: null,
    debitMandateDraftSha256: null,
    debitMandateEvidence: Prisma.DbNull,
    debitMandateEvidenceSha256: null,
    debitMandateSignedAt: null,
    debitMandateSignedMethod: null,
    debitMandateSignedByIp: null,
    debitMandateSignatureData: null,
    debitMandateSignatureSha256: null,
    debitMandateDocumentId: null,
    debitMandateDocumentSha256: null,
    // Credit-life fields are deliberately NOT reset, mirroring the production
    // route (`decide/route.ts` return-to-review, which never writes them). The
    // return-to-review trigger requires them IS NOT DISTINCT FROM their old
    // values, so clearing them is not a stricter reset — it stops being a
    // recognised return-to-review at all and the whole update is refused.
  }
}

suite("PASQ v3 billing and branch-witness database authority", () => {
  it("accepts only a loan and schedule that reproduce the acknowledged billing evidence", async () => {
    const scenario = await createApprovedPasqV3Application("valid")
    const loanId = await bookLoan(scenario)
    const loan = await prisma.loan.findUniqueOrThrow({
      where: { id: loanId, tenantId: scenario.tenantId },
      include: { repaymentSchedule: true },
    })
    expect(loan.totalRepayable).toBe(
      scenario.pasqEvidence.billing.totalRepayableCents,
    )
    expect(loan.creditLifePremiums).toBe(
      scenario.pasqEvidence.creditLife.totalPremiumCents,
    )
    expect(loan.repaymentSchedule[0].creditLifePremiumDue).toBe(2_250)
  })

  it("accepts an audited, ledger-balanced early DAILY_ACCRUAL settlement rebate", async () => {
    const scenario = await createApprovedPasqV3Application(
      "early-settlement",
    )
    const loanId = await bookLoan(scenario)
    const loan = await prisma.loan.findUniqueOrThrow({
      where: { id: loanId, tenantId: scenario.tenantId },
      include: { repaymentSchedule: true },
    })
    const contractualInterest =
      scenario.pasqEvidence.calculator.totalInterestCents
    const contractualTotal =
      scenario.pasqEvidence.billing.totalRepayableCents
    const resultingInterest = contractualInterest - 1
    const resultingTotal = contractualTotal - 1
    const closedAt = new Date("2026-07-27T09:00:00.000Z")

    await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          tenantId: scenario.tenantId,
          loanId,
          amount: resultingTotal,
          paymentMethod: "EFT",
          reference: "PASQ-V3-EARLY-SETTLEMENT",
          capturedBy: scenario.officerId,
        },
      })
      await tx.repaymentSchedule.update({
        where: {
          id: loan.repaymentSchedule[0].id,
          tenantId: scenario.tenantId,
        },
        data: {
          interestDue: resultingInterest,
          totalDue: resultingTotal,
          totalPaid: resultingTotal,
          status: "PAID",
          paidAt: closedAt,
        },
      })
      await tx.loan.update({
        where: { id: loanId, tenantId: scenario.tenantId },
        data: {
          totalInterest: resultingInterest,
          totalRepayable: resultingTotal,
          contractualTotalInterest: contractualInterest,
          contractualTotalRepayable: contractualTotal,
          totalPaid: resultingTotal,
          outstandingPrincipal: 0,
          status: "COMPLETED",
          closedAt,
          nextPaymentDate: null,
          arrearsAmount: 0,
          daysInArrears: 0,
        },
      })
      await tx.auditLog.create({
        data: {
          tenantId: scenario.tenantId,
          userId: scenario.officerId,
          action: "PAYMENT_RECORDED",
          entity: "Loan",
          entityId: loanId,
          newValue: {
            paymentId: payment.id,
            settlementDue: resultingTotal,
            earlyDailySettlement: true,
            accruedInterest: resultingInterest,
            interestRebate: 1,
            resultingTotalInterest: resultingInterest,
            resultingTotalRepayable: resultingTotal,
            contractualTotalInterest: contractualInterest,
            contractualTotalRepayable: contractualTotal,
          },
        },
      })
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    })

    const settled = await prisma.loan.findUniqueOrThrow({
      where: { id: loanId, tenantId: scenario.tenantId },
      include: { repaymentSchedule: true, payments: true },
    })
    expect(settled).toMatchObject({
      status: "COMPLETED",
      totalInterest: resultingInterest,
      totalRepayable: resultingTotal,
      contractualTotalInterest: contractualInterest,
      contractualTotalRepayable: contractualTotal,
      totalPaid: resultingTotal,
      outstandingPrincipal: 0,
    })
    expect(settled.repaymentSchedule).toEqual([
      expect.objectContaining({
        interestDue: resultingInterest,
        totalDue: resultingTotal,
        totalPaid: resultingTotal,
        status: "PAID",
      }),
    ])
    expect(settled.payments).toEqual([
      expect.objectContaining({ amount: resultingTotal }),
    ])
  })

  it("rejects a DAILY_ACCRUAL rebate without matching atomic audit evidence", async () => {
    const scenario = await createApprovedPasqV3Application(
      "unaudited-early-settlement",
    )
    const loanId = await bookLoan(scenario)
    const loan = await prisma.loan.findUniqueOrThrow({
      where: { id: loanId, tenantId: scenario.tenantId },
      include: { repaymentSchedule: true },
    })
    const contractualInterest =
      scenario.pasqEvidence.calculator.totalInterestCents
    const contractualTotal =
      scenario.pasqEvidence.billing.totalRepayableCents
    const resultingInterest = contractualInterest - 1
    const resultingTotal = contractualTotal - 1
    const closedAt = new Date("2026-07-27T09:00:00.000Z")

    await expect(prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          tenantId: scenario.tenantId,
          loanId,
          amount: resultingTotal,
          paymentMethod: "EFT",
          reference: "PASQ-V3-UNAUTHORISED-REBATE",
          capturedBy: scenario.officerId,
        },
      })
      await tx.repaymentSchedule.update({
        where: {
          id: loan.repaymentSchedule[0].id,
          tenantId: scenario.tenantId,
        },
        data: {
          interestDue: resultingInterest,
          totalDue: resultingTotal,
          totalPaid: resultingTotal,
          status: "PAID",
          paidAt: closedAt,
        },
      })
      await tx.loan.update({
        where: { id: loanId, tenantId: scenario.tenantId },
        data: {
          totalInterest: resultingInterest,
          totalRepayable: resultingTotal,
          totalPaid: resultingTotal,
          outstandingPrincipal: 0,
          status: "COMPLETED",
          closedAt,
        },
      })
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    })).rejects.toThrow(
      /Early DAILY_ACCRUAL settlement does not preserve PASQ v3 contractual and ledger evidence/i,
    )

    await expect(prisma.loan.findUniqueOrThrow({
      where: { id: loanId, tenantId: scenario.tenantId },
    })).resolves.toMatchObject({ status: "ACTIVE", totalPaid: 0 })
    await expect(prisma.payment.count({
      where: { loanId, tenantId: scenario.tenantId },
    })).resolves.toBe(0)
  })

  // main covered the ZERO-offset case: an agreement generated at the quote
  // instant, whose ledger dates reproduce the signed agreement exactly. The
  // shifted-offset case below is a different scenario, not a replacement, so
  // both are kept — dropping this one would stop testing offset == 0.
  it("accepts ledger dates that exactly reproduce the signed agreement", async () => {
    const scenario = await createApprovedPasqV3Application("valid-rebase")
    await expect(bookLoan(scenario)).resolves.toEqual(expect.any(String))
  })

  it("accepts a non-zero agreement rebase with exactly shifted ledger dates", async () => {
    const scenario = await createApprovedPasqV3Application(
      "valid-rebase",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {
        agreementGeneratedAt:
          new Date("2026-07-27T08:00:00.000Z"),
      },
    )
    await expect(bookLoan(scenario)).resolves.toEqual(expect.any(String))
  })

  it("rejects agreement generation before the acknowledged quote", async () => {
    await expect(createApprovedPasqV3Application(
      "agreement-before-quote",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {
        agreementGeneratedAt:
          new Date("2026-07-24T07:59:59.999Z"),
      },
    )).rejects.toThrow(
      /active contract evidence requires validated agreement generation/i,
    )
  })

  it("rejects agreement generation after the binding quote window", async () => {
    await expect(createApprovedPasqV3Application(
      "agreement-after-window",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {
        agreementGeneratedAt:
          new Date("2026-08-01T08:00:00.000Z"),
      },
    )).rejects.toThrow(
      /active contract evidence requires validated agreement generation/i,
    )
  })

  it("rejects a contract that extends the computed quote-valid date", async () => {
    await expect(createApprovedPasqV3Application(
      "altered-quote-valid-date",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {
        agreementGeneratedAt:
          new Date("2026-07-27T08:00:00.000Z"),
        quoteValidUntilDate: "2026-08-31",
      },
    )).rejects.toThrow(
      /active contract evidence requires validated agreement generation/i,
    )
  })

  it("rejects a contract schedule not shifted by the exact agreement offset", async () => {
    await expect(createApprovedPasqV3Application(
      "altered-rebase-offset",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {
        agreementGeneratedAt:
          new Date("2026-07-27T08:00:00.000Z"),
        firstDueDateOffsetMs: 1,
      },
    )).rejects.toThrow(
      /active contract evidence requires validated agreement generation/i,
    )
  })

  it("rejects payout on a later SAST date than the signed agreement", async () => {
    const scenario = await createApprovedPasqV3Application("expired-rebase")
    const fundedLater = {
      ...scenario,
      signedAt: new Date("2026-07-25T08:08:00.000Z"),
    }
    await expect(bookLoan(fundedLater)).rejects.toThrow(
      /quote window and signed agreement/i,
    )
  })

  // The case above books with repaymentMethod NULL, which takes the strict
  // path. These cover the EFT relaxation in the trigger
  // — the ONLY method for which payout may lag the signature.
  // A mocked Prisma cannot execute this trigger, so this is the only place the
  // scoping is actually proved.
  it("accepts an EFT payout lagging the signature when the schedule shifts with it", async () => {
    const scenario = await createApprovedPasqV3Application(
      "eft-lagged-payout",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {},
      "EFT",
    )
    const fundedLater = {
      ...scenario,
      signedAt: new Date("2026-07-27T08:08:00.000Z"),
    }
    await expect(bookLoan(fundedLater, 0, 3)).resolves.toEqual(
      expect.any(String),
    )
  })

  it("rejects an EFT payout lag the booked schedule does not carry", async () => {
    const scenario = await createApprovedPasqV3Application(
      "eft-unshifted-schedule",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {},
      "EFT",
    )
    const fundedLater = {
      ...scenario,
      signedAt: new Date("2026-07-27T08:08:00.000Z"),
    }
    // Relaxing the same-day rule must not relax the arithmetic: the term is
    // held at its disclosed length by shifting every due date by the payout
    // lag. Leaving the dates on the agreement offset shortens the term, which
    // is the rate-cap breach the change exists to prevent.
    await expect(bookLoan(fundedLater, 0, 0)).rejects.toThrow(
      /quote window and signed agreement/i,
    )
  })

  it("rejects an EFT payout beyond the binding quote window", async () => {
    const scenario = await createApprovedPasqV3Application(
      "eft-payout-after-window",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {},
      "EFT",
    )
    const fundedTooLate = {
      ...scenario,
      signedAt: new Date("2026-08-01T08:08:00.000Z"),
    }
    await expect(bookLoan(fundedTooLate, 0, 8)).rejects.toThrow(
      /quote window and signed agreement/i,
    )
  })

  // The paired accept case for the bound above. Without it the guard could use
  // `>=` and still pass every other test here, silently costing the consumer
  // the last lawful day of a window s92(3) grants them. 2026-07-31 IS the
  // valid-until date for this fixture's quote, not the day after it.
  it("accepts an EFT payout on the last day of the quote window", async () => {
    const scenario = await createApprovedPasqV3Application(
      "eft-payout-on-window-boundary",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {},
      "EFT",
    )
    const fundedOnBoundary = {
      ...scenario,
      signedAt: new Date("2026-07-31T08:08:00.000Z"),
    }
    await expect(bookLoan(fundedOnBoundary, 0, 7)).resolves.toEqual(
      expect.any(String),
    )
  })

  it("rejects an EFT payout dated before the agreement", async () => {
    const scenario = await createApprovedPasqV3Application(
      "eft-payout-before-agreement",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {},
      "EFT",
    )
    const fundedEarlier = {
      ...scenario,
      signedAt: new Date("2026-07-23T08:08:00.000Z"),
    }
    await expect(bookLoan(fundedEarlier, 0, -1)).rejects.toThrow(
      /quote window and signed agreement/i,
    )
  })

  it("keeps the same-day rule for an explicit DEBIT_ORDER", async () => {
    const scenario = await createApprovedPasqV3Application(
      "debit-order-lagged-payout",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {},
      "DEBIT_ORDER",
    )
    const fundedLater = {
      ...scenario,
      signedAt: new Date("2026-07-27T08:08:00.000Z"),
    }
    // A signed mandate fixes the debit dates before payout, so a lagged payout
    // has no lawful schedule to book against — with or without the shift.
    await expect(bookLoan(fundedLater, 0, 3)).rejects.toThrow(
      /quote window and signed agreement/i,
    )
    await expect(bookLoan(fundedLater, 0, 0)).rejects.toThrow(
      /quote window and signed agreement/i,
    )
  })

  it("counts a configured proclaimed holiday in the quote window", async () => {
    const rows = await prisma.$queryRaw<Array<{ validUntilDate: string }>>`
      SELECT TO_CHAR(
        "quoteValidUntilDate"(
          TIMESTAMPTZ '2024-05-22T08:00:00.000Z'
        ),
        'YYYY-MM-DD'
      ) AS "validUntilDate"
    `
    expect(rows).toEqual([{ validUntilDate: "2024-05-30" }])
  })

  it("observes Monday when a configured proclaimed holiday falls on Sunday", async () => {
    const sunday = new Date("2026-07-26T00:00:00.000Z")
    await prisma.saProclaimedPublicHoliday.upsert({
      where: { date: sunday },
      create: {
        date: sunday,
        name: "Synthetic Sunday proclamation",
        sourceUrl: "https://example.invalid/synthetic-test-proclamation",
      },
      update: {},
    })
    try {
      const rows = await prisma.$queryRaw<Array<{ validUntilDate: string }>>`
        SELECT TO_CHAR(
          "quoteValidUntilDate"(
            TIMESTAMPTZ '2026-07-21T08:00:00.000Z'
          ),
          'YYYY-MM-DD'
        ) AS "validUntilDate"
      `
      expect(rows).toEqual([{ validUntilDate: "2026-07-29" }])
    } finally {
      await prisma.saProclaimedPublicHoliday.delete({
        where: { date: sunday },
      })
    }
  })

  it("rejects a loan total that excludes part of the accepted premium", async () => {
    const scenario = await createApprovedPasqV3Application("wrong-total")
    await expect(bookLoan(scenario, -1)).rejects.toThrow(
      /acknowledged PASQ v3 billing evidence/i,
    )
  })

  it("rejects later mutation of every protected repayment amount", async () => {
    const scenario = await createApprovedPasqV3Application("mutated-schedule")
    const loanId = await bookLoan(scenario)
    const row = await prisma.repaymentSchedule.findFirstOrThrow({
      where: { loanId, tenantId: scenario.tenantId },
    })
    await expect(prisma.repaymentSchedule.update({
      where: { id: row.id, tenantId: scenario.tenantId },
      data: { principalDue: row.principalDue + 1 },
    })).rejects.toThrow(/repayment schedule does not match/i)
    await expect(prisma.repaymentSchedule.update({
      where: { id: row.id, tenantId: scenario.tenantId },
      data: { interestDue: row.interestDue + 1 },
    })).rejects.toThrow(/repayment schedule does not match/i)
    await expect(prisma.repaymentSchedule.update({
      where: { id: row.id, tenantId: scenario.tenantId },
      data: { creditLifePremiumDue: row.creditLifePremiumDue - 1 },
    })).rejects.toThrow(/repayment schedule does not match/i)
    await expect(prisma.repaymentSchedule.update({
      where: { id: row.id, tenantId: scenario.tenantId },
      data: { feesDue: row.feesDue + 1 },
    })).rejects.toThrow(/repayment schedule does not match/i)
    await expect(prisma.repaymentSchedule.update({
      where: { id: row.id, tenantId: scenario.tenantId },
      data: { totalDue: row.totalDue + 1 },
    })).rejects.toThrow(/repayment schedule does not match/i)
  })

  it("rejects moving a booked repayment to another disclosed SAST date", async () => {
    const scenario = await createApprovedPasqV3Application("mutated-date")
    const loanId = await bookLoan(scenario)
    const row = await prisma.repaymentSchedule.findFirstOrThrow({
      where: { loanId, tenantId: scenario.tenantId },
    })
    await expect(prisma.repaymentSchedule.update({
      where: { id: row.id, tenantId: scenario.tenantId },
      data: { dueDate: new Date(row.dueDate.getTime() + 86_400_000) },
    })).rejects.toThrow(/schedule dates do not match/i)
  })

  it.each(alteredMandateTerms)(
    "rejects a signed mandate with an altered %s",
    async (label, alter) => {
      const scenario = await createApprovedPasqV3Application(
        `altered-mandate-${label.replaceAll(" ", "-")}`,
      )
      const stored = await prisma.loanApplication.findUniqueOrThrow({
        where: {
          id: scenario.applicationId,
          tenantId: scenario.tenantId,
        },
        select: { debitMandateEvidence: true },
      })
      const evidence = readDebitMandateEvidence(
        stored.debitMandateEvidence,
      )
      expect(evidence).not.toBeNull()
      const altered = alter(evidence!)
      await expect(prisma.loanApplication.update({
        where: {
          id: scenario.applicationId,
          tenantId: scenario.tenantId,
        },
        data: {
          debitMandateEvidence:
            altered as unknown as Prisma.InputJsonValue,
          debitMandateEvidenceSha256:
            debitMandateEvidenceSha256(altered),
        },
      })).rejects.toThrow(/terms bound to the signed contract|immutable/i)
    },
  )

  it("rejects a coherent replacement of signed mandate and contract fingerprints before payout", async () => {
    const scenario = await createApprovedPasqV3Application(
      "coherent-mandate-replacement",
    )
    const stored = await prisma.loanApplication.findUniqueOrThrow({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      select: {
        affordabilityResult: true,
        debitMandateEvidence: true,
      },
    })
    const evidence = readDebitMandateEvidence(stored.debitMandateEvidence)
    expect(evidence).not.toBeNull()
    const replacementFingerprint = "0".repeat(64)
    const alteredEvidence = {
      ...evidence!,
      contractFingerprint: replacementFingerprint,
    }
    const alteredAffordability = structuredClone(
      stored.affordabilityResult,
    ) as {
      contract: {
        fingerprint: string
      }
    }
    alteredAffordability.contract.fingerprint = replacementFingerprint

    await expect(prisma.loanApplication.update({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      data: {
        affordabilityResult:
          alteredAffordability as unknown as Prisma.InputJsonValue,
        debitMandateEvidence:
          alteredEvidence as unknown as Prisma.InputJsonValue,
        debitMandateEvidenceSha256:
          debitMandateEvidenceSha256(alteredEvidence),
      },
    })).rejects.toThrow(
      /signed debit-mandate authority is immutable|archived contract evidence must exactly record|active contract evidence requires validated agreement generation/i,
    )
  })

  it("rejects an operational initiation-fee election that differs from the signed approval", async () => {
    await expect(createApprovedPasqV3Application(
      "initiation-fee-election-mismatch",
      "ACCEPTED",
      true,
      "UPFRONT",
    )).rejects.toThrow(
      /terms bound to the signed contract|active approval evidence requires a validated approval transition/i,
    )
  })

  it.each([
    ["approval decision", "approval_hash"],
    ["contract envelope", "contract_hash"],
  ] as const)(
    "cryptographically rejects a forged %s hash during its otherwise valid lifecycle transition",
    async (_label, tamperFinalEvidence) => {
      await expect(createApprovedPasqV3Application(
        `forged-${tamperFinalEvidence}`,
        "ACCEPTED",
        true,
        "DEFERRED",
        false,
        tamperFinalEvidence,
      )).rejects.toThrow(
        /active (approval|contract) evidence requires/i,
      )
    },
  )

  it("allows evidence-free inserts and rejects staged active or archived evidence fabrication", async () => {
    const scenario = await createApprovedPasqV3Application(
      "decision-history-insert",
      "DECLINED",
      false,
    )
    const createApplication = (
      label: string,
      affordabilityResult: Prisma.InputJsonValue,
    ) => {
      const token = randomUUID().replaceAll("-", "")
      return prisma.loanApplication.create({
        data: {
          id: `application_history_insert_${label}_${token}`,
          tenantId: scenario.tenantId,
          reference: `APP-HISTORY-INSERT-${label}-${token}`,
          clientId: scenario.clientId,
          productId: scenario.productId,
          appliedAmount: scenario.calculation.principal,
          appliedTermDays: 30,
          status: "DECLINED",
          affordabilityResult,
        },
      })
    }

    const historyFreeApplication = await createApplication(
      "history-free",
      {
        schemaVersion: 3,
        submissionMarker: "normal-insert",
      },
    )
    expect(historyFreeApplication).toMatchObject({
      status: "DECLINED",
      affordabilityResult: {
        submissionMarker: "normal-insert",
      },
    })

    const forbiddenHistoryValues: Array<{
      label: string
      value: unknown
    }> = [
      { label: "empty-array", value: [] },
      { label: "json-null", value: null },
      { label: "scalar", value: "fabricated" },
      { label: "object", value: { fabricated: true } },
      { label: "populated-array", value: [{ fabricated: true }] },
    ]

    for (const evidenceKey of [
      "approval",
      "contract",
      "approvalHistory",
      "contractHistory",
    ] as const) {
      for (const forbidden of forbiddenHistoryValues) {
        await expect(createApplication(
          `${evidenceKey}-${forbidden.label}`,
          {
            schemaVersion: 3,
            [evidenceKey]: forbidden.value,
          } as unknown as Prisma.InputJsonValue,
        )).rejects.toThrow(
          /active and archived decision evidence require a validated lifecycle transition/i,
        )
      }
    }

    for (const evidenceKey of ["approval", "contract"] as const) {
      await expect(prisma.loanApplication.update({
        where: {
          id: historyFreeApplication.id,
          tenantId: scenario.tenantId,
        },
        data: {
          affordabilityResult: {
            schemaVersion: 3,
            submissionMarker: "normal-insert",
            [evidenceKey]: {
              fabricated: true,
            },
          },
        },
      })).rejects.toThrow(
        new RegExp(
          `active ${evidenceKey} evidence requires`,
          "i",
        ),
      )
    }
  })

  it("permits only a complete return-to-review reset and retains the signed mandate artifact immutably", async () => {
    const scenario = await createApprovedPasqV3Application(
      "mandate-return-to-review",
      "ACCEPTED",
      true,
      "DEFERRED",
      true,
    )
    const before = await prisma.loanApplication.findUniqueOrThrow({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      select: {
        affordabilityResult: true,
        bureauReviewGeneration: true,
        debitMandateDocumentId: true,
      },
    })
    expect(before.debitMandateDocumentId).not.toBeNull()

    const resetData = signedMandateReturnToReviewData({
      officerId: scenario.officerId,
      affordabilityResult: before.affordabilityResult,
    })
    const signedAuthorityOrHistoryGuard =
      /signed debit-mandate authority is immutable|archived (approval|contract) evidence/i

    await expect(prisma.loanApplication.update({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      data: {
        ...resetData,
        affordabilityResult: {} as Prisma.InputJsonValue,
      },
    })).rejects.toThrow(signedAuthorityOrHistoryGuard)

    const truncatedAffordability = structuredClone(
      resetData.affordabilityResult,
    ) as Record<string, unknown>
    delete truncatedAffordability.preservedReviewMarker
    await expect(prisma.loanApplication.update({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      data: {
        ...resetData,
        affordabilityResult:
          truncatedAffordability as Prisma.InputJsonValue,
      },
    })).rejects.toThrow(signedAuthorityOrHistoryGuard)

    const supersetAffordability = structuredClone(
      resetData.affordabilityResult,
    ) as {
      approvalHistory: unknown[]
    }
    supersetAffordability.approvalHistory.push({
      injected: "not-route-history",
    })
    await expect(prisma.loanApplication.update({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      data: {
        ...resetData,
        affordabilityResult:
          supersetAffordability as unknown as Prisma.InputJsonValue,
      },
    })).rejects.toThrow(signedAuthorityOrHistoryGuard)

    await expect(prisma.loanApplication.update({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      data: {
        ...resetData,
        appliedAmount: scenario.calculation.principal + 1,
      },
    })).rejects.toThrow(/signed debit-mandate authority is immutable/i)

    await expect(prisma.loanApplication.update({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      data: resetData,
      select: {
        status: true,
        affordabilityResult: true,
        bureauReviewGeneration: true,
        debitMandateDocumentId: true,
      },
    })).resolves.toMatchObject({
      status: "UNDER_REVIEW",
      debitMandateDocumentId: null,
    })

    const returned = await prisma.loanApplication.findUniqueOrThrow({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      select: {
        affordabilityResult: true,
        bureauReviewGeneration: true,
      },
    })
    const returnedAffordability = readAffordabilitySnapshotStore(
      returned.affordabilityResult,
    )
    expect(returnedAffordability.approval).toBeUndefined()
    expect(returnedAffordability.contract).toBeUndefined()
    expect(returnedAffordability.approvalHistory).toHaveLength(2)
    expect(returnedAffordability.contractHistory).toHaveLength(2)
    expect(returned.affordabilityResult).toMatchObject({
      preservedReviewMarker: {
        cycle: "prior-review",
        retained: true,
      },
    })
    expect(returned.bureauReviewGeneration).not.toBe(
      before.bureauReviewGeneration,
    )

    const postResetAffordability = structuredClone(
      returned.affordabilityResult,
    ) as {
      approvalHistory: unknown[]
      contractHistory: unknown[]
    }
    const destructiveHistoryUpdates: Array<{
      label: string
      affordabilityResult: Prisma.InputJsonValue
    }> = [
      {
        label: "delete all archived evidence",
        affordabilityResult: {},
      },
      {
        label: "truncate approval history",
        affordabilityResult: {
          ...postResetAffordability,
          approvalHistory: postResetAffordability.approvalHistory.slice(1),
        } as Prisma.InputJsonValue,
      },
      {
        label: "replace an approval history entry",
        affordabilityResult: {
          ...postResetAffordability,
          approvalHistory: [
            { replaced: true },
            ...postResetAffordability.approvalHistory.slice(1),
          ],
        } as Prisma.InputJsonValue,
      },
      {
        label: "reorder contract history",
        affordabilityResult: {
          ...postResetAffordability,
          contractHistory:
            [...postResetAffordability.contractHistory].reverse(),
        } as Prisma.InputJsonValue,
      },
      {
        label: "mutate a contract history entry",
        affordabilityResult: {
          ...postResetAffordability,
          contractHistory: [
            ...postResetAffordability.contractHistory.slice(0, -1),
            { mutated: true },
          ],
        } as Prisma.InputJsonValue,
      },
      {
        label: "append fabricated approval history",
        affordabilityResult: {
          ...postResetAffordability,
          approvalHistory: [
            ...postResetAffordability.approvalHistory,
            { fabricated: true },
          ],
        } as Prisma.InputJsonValue,
      },
      {
        label: "append fabricated contract history",
        affordabilityResult: {
          ...postResetAffordability,
          contractHistory: [
            ...postResetAffordability.contractHistory,
            { fabricated: true },
          ],
        } as Prisma.InputJsonValue,
      },
    ]

    for (const destructiveUpdate of destructiveHistoryUpdates) {
      await expect(prisma.loanApplication.update({
        where: {
          id: scenario.applicationId,
          tenantId: scenario.tenantId,
        },
        data: {
          affordabilityResult: destructiveUpdate.affordabilityResult,
        },
      }), destructiveUpdate.label).rejects.toThrow(
        /archived (approval|contract) evidence/i,
      )
    }

    await expect(prisma.clientDocument.update({
      where: {
        id: before.debitMandateDocumentId!,
        tenantId: scenario.tenantId,
      },
      data: { fileName: "rewritten-signed-mandate.pdf" },
    })).rejects.toThrow(/signed debit-mandate documents are immutable/i)
  })

  it("does not revalidate legacy PASQ evidence for payment-progress projections", async () => {
    const scenario = await createApprovedPasqV3Application("legacy-progress")
    const loanId = await bookLoan(scenario)
    const row = await prisma.repaymentSchedule.findFirstOrThrow({
      where: { loanId, tenantId: scenario.tenantId },
    })

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "SET LOCAL session_replication_role = replica",
      )
      await tx.repaymentSchedule.update({
        where: { id: row.id, tenantId: scenario.tenantId },
        data: { totalDue: row.totalDue + 1 },
      })
    })

    await expect(prisma.loan.update({
      where: { id: loanId, tenantId: scenario.tenantId },
      data: {
        lastPaymentAmount: 1,
        lastPaymentDate: new Date("2026-07-25T08:00:00.000Z"),
      },
    })).resolves.toMatchObject({ lastPaymentAmount: 1 })
    await expect(prisma.repaymentSchedule.update({
      where: { id: row.id, tenantId: scenario.tenantId },
      data: {
        totalPaid: 1,
        paidAt: new Date("2026-07-25T08:00:00.000Z"),
        status: "PARTIAL",
      },
    })).resolves.toMatchObject({ totalPaid: 1, status: "PARTIAL" })

    const loan = await prisma.loan.findUniqueOrThrow({
      where: { id: loanId, tenantId: scenario.tenantId },
    })
    await expect(prisma.loan.update({
      where: { id: loanId, tenantId: scenario.tenantId },
      data: { principal: loan.principal + 1 },
    })).rejects.toThrow(
      /acknowledged PASQ v3 billing evidence|frozen loan principal/i,
    )
    await expect(prisma.repaymentSchedule.update({
      where: { id: row.id, tenantId: scenario.tenantId },
      data: { dueDate: new Date(row.dueDate.getTime() + 86_400_000) },
    })).rejects.toThrow(/schedule dates do not match/i)
  })

  it("commits an ordinary receipt without initializing legacy-null contractual totals", async () => {
    const scenario = await createApprovedPasqV3Application(
      "legacy-null-contractual-progress",
    )
    const loanId = await bookLoan(scenario)
    const row = await prisma.repaymentSchedule.findFirstOrThrow({
      where: { loanId, tenantId: scenario.tenantId },
    })

    // Reproduce the deployed legacy shape: tolerated pre-existing schedule
    // drift plus NULL contractual totals from before the contractual-total
    // columns were enforced. The repair uses replica mode only to construct that
    // historical fixture; the receipt itself goes through the production
    // transaction path and all live guards.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "SET LOCAL session_replication_role = replica",
      )
      await tx.repaymentSchedule.update({
        where: { id: row.id, tenantId: scenario.tenantId },
        data: { totalDue: row.totalDue + 1 },
      })
      await tx.loan.update({
        where: { id: loanId, tenantId: scenario.tenantId },
        data: {
          contractualTotalInterest: null,
          contractualTotalRepayable: null,
        },
      })
    })

    await expect(runWithTenant(
      scenario.tenantId,
      () => applyManualReceipt(prisma, {
        loanId,
        tenantId: scenario.tenantId,
        amount: 1,
        paymentMethod: "EFT",
        reference: "LEGACY-NULL-PARTIAL",
        capturedById: scenario.officerId,
        capturedByEmail: "legacy-null@example.test",
        idempotencyKey: `legacy-null-${randomUUID()}`,
      }),
    )).resolves.toMatchObject({
      idempotentReplay: false,
      payment: {
        loanId,
        amount: 1,
      },
    })

    await expect(prisma.loan.findUniqueOrThrow({
      where: { id: loanId, tenantId: scenario.tenantId },
    })).resolves.toMatchObject({
      totalPaid: 1,
      contractualTotalInterest: null,
      contractualTotalRepayable: null,
    })
    await expect(prisma.payment.count({
      where: { loanId, tenantId: scenario.tenantId },
    })).resolves.toBe(1)
  })

  it("requires an active authorised branch witness from the application tenant", async () => {
    const scenario = await createApprovedPasqV3Application(
      "branch-witness",
      "DECLINED",
      false,
    )
    const otherTenantId = `other_${randomUUID().replaceAll("-", "")}`
    const otherUserId = `other_user_${randomUUID().replaceAll("-", "")}`
    const readonlyUserId = `readonly_${randomUUID().replaceAll("-", "")}`
    const authorisedUserId = `authorised_${randomUUID().replaceAll("-", "")}`
    await prisma.tenant.create({
      data: {
        id: otherTenantId,
        slug: `other-${randomUUID()}`,
        name: "Other synthetic tenant",
      },
    })
    await prisma.user.createMany({
      data: [
        {
          id: otherUserId,
          tenantId: otherTenantId,
          email: `${otherUserId}@example.invalid`,
          password: "not-a-real-login",
          role: "LOAN_ADMIN",
        },
        {
          id: readonlyUserId,
          tenantId: scenario.tenantId,
          email: `${readonlyUserId}@example.invalid`,
          password: "not-a-real-login",
          role: "READONLY",
        },
        {
          id: authorisedUserId,
          tenantId: scenario.tenantId,
          email: `${authorisedUserId}@example.invalid`,
          password: "not-a-real-login",
          role: "CREDIT_OFFICER",
        },
      ],
    })
    const signedAt = new Date("2026-07-24T08:20:00.000Z")
    const signatureData = "data:image/png;base64,YnJhbmNoLXdpdG5lc3M="
    const signWith = (agreementSignedByUserId: string) =>
      prisma.loanApplication.update({
        where: {
          id: scenario.applicationId,
          tenantId: scenario.tenantId,
        },
        data: {
          agreementGeneratedAt: signedAt,
          agreementDocumentId: `agreement-${scenario.applicationId}`,
          agreementDocumentSha256: "b".repeat(64),
          agreementSignedAt: signedAt,
          agreementSignedMethod: "branch",
          agreementSignedByUserId,
          agreementSignatureData: signatureData,
        },
      })

    await expect(signWith(otherUserId)).rejects.toThrow()
    await expect(signWith(readonlyUserId)).rejects.toThrow(
      /active authorised witness/i,
    )
    const signed = await signWith(authorisedUserId)
    expect(signed.agreementSignedByUserId).toBe(authorisedUserId)

    // Authority is evaluated at the instant of signing. A later, legitimate
    // staff deactivation must preserve the historical witness evidence without
    // freezing unrelated lifecycle updates on the signed application.
    await prisma.user.update({
      where: { id: authorisedUserId, tenantId: scenario.tenantId },
      data: { active: false },
    })
    const progressed = await prisma.loanApplication.update({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      data: { purpose: "Post-signing lifecycle progression" },
    })
    expect(progressed.purpose).toBe("Post-signing lifecycle progression")
  })
})

import { createHash, randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { CREDIT_LIFE_DISCLOSURE_VERSION } from "@/lib/insurance/credit-life-election"
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

/**
 * Shared PASQ v3 integration fixture: builds an APPROVED, countersigned
 * application against a migrated database, and books its loan. Rows it creates
 * are not cleaned up — the signed evidence is immutable.
 */


type FixtureContract = ReturnType<
  typeof createApplicationContractFixture
>["affordabilityResult"]["contract"]

export type ContractInstallOptions = {
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

// What the completed agreement artifact records as the credit-life election.
// "missing" writes no artifact; "malformed" writes a non-boolean value.
export type AgreementArtifactElection = boolean | "missing" | "malformed"

export async function createApprovedPasqV3Application(
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
  // Defaults to the PASQ election. A completed artifact is immutable, so a
  // scenario that needs a missing or malformed one is created with it.
  agreementArtifactElection: AgreementArtifactElection = election === "ACCEPTED",
  // The consumer signs the agreement and the debit mandate first and the
  // provider countersignature is left for the caller to write (`countersign`
  // in the result): the order the portal allows.
  countersignAfterMandate = false,
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
  const countersign = {
    agreementCountersignedAt: countersignedAt,
    agreementCountersignedById: officerId,
    agreementCountersignedByName: providerSignerName,
    agreementCountersignedByEmail: providerSignerEmail,
    agreementCountersignatureData: providerSignatureData,
    agreementCountersignatureSha256: providerSignatureSha256,
    agreementCountersignatureEnvelopeSha256: providerEnvelopeSha256,
    agreementCountersignedDocumentSha256: agreementDocumentSha256,
  }
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
  // Pays out: segregation of duties (on by default) refuses the approver.
  const payerId = `payer_pasq_v3_${label}_${token}`
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
  await prisma.user.create({
    data: {
      id: payerId,
      tenantId,
      email: `pasq-v3-payer-${label}-${token}@example.invalid`,
      password: "not-a-real-login",
      name: "Synthetic Payer",
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
        ...(countersignAfterMandate ? {} : countersign),
        ...debitMandate,
      },
    })
  }
  const insuranceProductId = disclosure.productId
  if (withDisbursementAgreement && agreementArtifactElection !== "missing") {
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
          creditLifeAutoBundleEligible:
            agreementArtifactElection === "malformed"
              ? "true"
              : agreementArtifactElection,
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
    countersign,
    payerId,
  }
}

export type PasqV3Scenario = Awaited<
  ReturnType<typeof createApprovedPasqV3Application>
>

type WriteOptions = {
  totalRepayableOffset?: number
  // Whole SAST days the booked schedule is shifted BEYOND the agreement
  // offset, i.e. the payout lag. Only an EFT loan may carry a non-zero value;
  // for every other repayment method the trigger requires payout and agreement
  // to fall on the same SAST date, so the shift has nowhere to come from.
  payoutShiftDays?: number
  // Let a caller know the ids of rows a rolled-back transaction would create.
  loanId?: string
  policyId?: string
  // "auto" writes the bundled policy when the PASQ election is ACCEPTED, as
  // the route does; "none" never writes one; "missing_product" writes one with
  // no product, whatever the election.
  policy?: "auto" | "none" | "missing_product"
  // Field overrides for the bundled policy, given the terms it is bound to.
  policyOverrides?: (terms: { startDate: Date; maturityDate: Date }) =>
    Partial<Prisma.InsurancePolicyUncheckedCreateInput>
  // Runs inside the transaction once the policy row is written.
  afterPolicyCreated?: () => Promise<void>
  // "route": loan, application DISBURSED, schedule, then policy (the policy
  // after the application, as in the disburse route). "policy-before-application":
  // loan, policy, application, schedule, so the policy guard reads the product
  // before the application's credit-life offer guard does.
  order?: "route" | "policy-before-application"
}

// The tenant-scoped `@/lib/prisma` client's transaction and a plain
// `new PrismaClient()`'s transaction are different, non-assignable types.
type DisbursementTransaction =
  | Prisma.TransactionClient
  | Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/** The disbursement writes, on the caller's transaction. */
export async function writePasqV3Disbursement(
  transaction: DisbursementTransaction,
  scenario: PasqV3Scenario,
  {
    totalRepayableOffset = 0,
    payoutShiftDays = 0,
    loanId = `loan_${randomUUID().replaceAll("-", "")}`,
    policyId,
    policy = "auto",
    policyOverrides,
    afterPolicyCreated,
    order = "route",
  }: WriteOptions = {},
) {
  const tx = transaction as Prisma.TransactionClient
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
  const startDate = scenario.signedAt
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
      startDate,
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
  const writePolicy = async (): Promise<string | null> => {
    if (
      policy === "none"
      || (
        policy === "auto"
        && (
          scenario.pasqEvidence.creditLife.election !== "ACCEPTED"
          || !scenario.insuranceProductId
        )
      )
    ) {
      return null
    }
    const created = await tx.insurancePolicy.create({
      select: { id: true },
      data: {
        ...(policyId ? { id: policyId } : {}),
        tenantId: scenario.tenantId,
        policyNumber: `CL-PV3-${randomUUID()}`,
        clientId: scenario.clientId,
        type: "CREDIT_LIFE",
        status: "ACTIVE",
        premiumAmount:
          scenario.pasqEvidence.creditLife.monthlyPremiumCents / 100,
        sumAssured: scenario.pasqEvidence.calculator.principalCents / 100,
        linkedLoanId: loanId,
        startDate,
        renewalDate: maturityDate,
        ...(policy === "missing_product"
          ? {}
          : { productId: scenario.insuranceProductId }),
        policySource: "BUNDLED_CREDIT_AGREEMENT",
        ...policyOverrides?.({ startDate, maturityDate }),
      },
    })
    await afterPolicyCreated?.()
    return created.id
  }
  let createdPolicyId: string | null = null
  if (order === "policy-before-application") {
    createdPolicyId = await writePolicy()
  }
  await tx.loanApplication.update({
    where: {
      id: scenario.applicationId,
      tenantId: scenario.tenantId,
    },
    data: {
      status: "DISBURSED",
      disbursedAt: scenario.signedAt,
      disbursedById: scenario.payerId,
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
  if (order === "route") createdPolicyId = await writePolicy()
  return { loanId, policyId: createdPolicyId, startDate, maturityDate }
}

export async function bookLoan(
  scenario: PasqV3Scenario,
  totalRepayableOffset = 0,
  payoutShiftDays = 0,
) {
  return prisma.$transaction(async (tx) => {
    const { loanId } = await writePasqV3Disbursement(tx, scenario, {
      totalRepayableOffset,
      payoutShiftDays,
    })
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    return loanId
  })
}

export function signedMandateReturnToReviewData(args: {
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
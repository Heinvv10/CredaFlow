import type { LoanCalcResult } from "@/lib/loan-calculator"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import { recordDisbursementCommission } from "@/lib/referral-agents/commission"
import { CORE_KYC_DOCUMENT_TYPES } from "@/lib/kyc/document-state"
import {
  affordabilityContractEvidenceIsIntact,
  affordabilityDecisionSnapshotIsIntact,
  loanCalculationFromEvidence,
  readAffordabilitySnapshotStore,
} from "@/lib/affordability/snapshot"
import {
  createOutageExceptionEvidence,
  isOutageIncidentId,
  normalizeSastDateOnly,
  OUTAGE_APPLICATIONS,
  outageApplicationIdsForIncident,
  outageApplicationPolicy,
  outageDisbursementRef,
  parseOutageExceptionEvidence,
  type OutageApplicationPolicy,
  type OutageIncidentId,
} from "./outage-exception"

export interface OutageVerifiedBankStatement {
  documentId: string
  documentSha256: string
  verifiedAt: Date
  bankName: string
  accountNumber: string
  branchCode: string
  accountType: string
}

export interface OutageReconciliationApplication {
  id: string
  tenantId: string
  reference: string
  productId: string
  status: string
  approvedAmount: number | null
  approvedTermDays: number | null
  approvedRate: number | null
  repaymentMethod: string | null
  creditLifeElection: string | null
  creditLifeProductId: string | null
  creditLifeInsurerId: string | null
  creditLifeMonthlyPremiumCents: number | null
  affordabilityResult: unknown
  agreementDocumentId: string | null
  loan: { id: string } | null
  coreDocumentsVerified: boolean
  client: {
    id: string
    bankName: string | null
    bankAccountNumber: string | null
    bankBranchCode: string | null
    accountType: string | null
  }
  verifiedBankStatements: OutageVerifiedBankStatement[]
}

export interface OutageReconciliationPlan {
  applicationId: string
  applicationReference: string
  tenantId: string
  clientId: string
  productId: string
  calculatorSource: "CONTRACT" | "APPROVAL"
  /** From the application's own policy — incidents have different payout dates. */
  incidentId: OutageIncidentId
  payoutDate: OutageApplicationPolicy["payoutDate"]
  disbursementRef: OutageApplicationPolicy["disbursementRef"]
  managementApprovedBy: OutageApplicationPolicy["managementApprovedBy"]
  calculatorPricingFingerprint: string
  calculatorContractFingerprint: string
  calculation: LoanCalcResult
  /** agreed monthly service fee, from the approval snapshot */
  monthlyServiceFee: number
  disbursedAt: Date
  startDate: Date
  maturityDate: Date
  nextPaymentDate: Date
  agreementDocumentId: string | null
  waivedPreconditions: OutageApplicationPolicy["waivedPreconditions"]
  bankEvidence: {
    payoutProfile: {
      bankName: string
      accountNumber: string
      branchCode: string
      accountType: string
    }
    verifiedStatements: OutageVerifiedBankStatement[]
    exactStatementMatch: boolean
  }
}

export interface OutageLoadedApplication
  extends Omit<OutageReconciliationApplication, "loan"> {
  loan: { id: string } | null
  disbursedAt: Date | null
  disbursementExceptionId: string | null
  disbursementException: {
    id: string
    status: string
    completedAt: Date | null
    data: unknown
  } | null
}

type ScopedTransactionClient = Parameters<
  Parameters<typeof prisma.$transaction>[0]
>[0]

export interface OutageReconciliationDependencies {
  prisma: Pick<typeof prisma, "$transaction">
  loadApplication: (
    tx: ScopedTransactionClient,
    tenantId: string,
    applicationId: string,
  ) => Promise<OutageLoadedApplication | null>
  recordCommission: (
    tx: ScopedTransactionClient,
    args: {
      tenantId: string
      loanId: string
      clientId: string
      principalCents: number
    },
  ) => Promise<void>
  now: () => Date
}

export interface OutageReconciliationResult {
  mode: "DRY_RUN" | "APPLIED" | "ALREADY_RECONCILED"
  incidentId: OutageIncidentId
  applications: Array<
    OutageReconciliationPlan & {
      loanId?: string
      exceptionId?: string
    }
  >
}

function normalizedBankValue(value: string): string {
  return value.trim().toUpperCase()
}

function exactBankMatch(
  statement: OutageVerifiedBankStatement,
  payoutProfile: OutageReconciliationPlan["bankEvidence"]["payoutProfile"],
): boolean {
  // NOTE on OTHER: an explicit `OTHER` short-circuit was added here and then
  // removed as dead code. `buildOutageReconciliationPlan` calls
  // `assertReviewedCohort` before this runs, which throws unless the client's
  // account type equals the frozen cohort's expected payout profile — and no
  // policy may declare OTHER. So `payoutProfile.accountType` can never
  // be OTHER by the time this executes, and a statement-side OTHER already
  // fails the trailing equality below. A guard that cannot change an outcome is
  // worse than none: it reads as protection and is not.
  return (
    normalizedBankValue(statement.bankName)
      === normalizedBankValue(payoutProfile.bankName)
    && statement.accountNumber.trim() === payoutProfile.accountNumber.trim()
    && statement.branchCode.trim() === payoutProfile.branchCode.trim()
    && normalizedBankValue(statement.accountType)
      === normalizedBankValue(payoutProfile.accountType)
  )
}

function assertReviewedCohort(
  application: OutageReconciliationApplication,
  policy: OutageApplicationPolicy,
): void {
  const expectedBank = policy.expectedPayoutProfile
  if (
    !expectedBank
    || application.id !== policy.applicationId
    || application.reference !== policy.reference
    || application.status !== "APPROVED"
    || application.approvedAmount !== policy.principalCents
    || application.approvedTermDays !== policy.termDays
    || application.approvedRate !== policy.interestRatePm
    || application.repaymentMethod !== policy.repaymentMethod
    || application.creditLifeElection !== policy.creditLifeElection
    || application.creditLifeProductId !== null
    || application.creditLifeInsurerId !== null
    || application.creditLifeMonthlyPremiumCents !== 0
    || application.loan !== null
    || !application.coreDocumentsVerified
    || application.client.bankName !== expectedBank.bankName
    || application.client.bankBranchCode !== expectedBank.branchCode
    || application.client.accountType !== expectedBank.accountType
  ) {
    throw new Error("Application no longer matches the reviewed outage cohort")
  }
}

export function buildOutageReconciliationPlan(
  application: OutageReconciliationApplication,
  policy: OutageApplicationPolicy,
): OutageReconciliationPlan {
  assertReviewedCohort(application, policy)

  const payoutProfile = {
    bankName: application.client.bankName ?? "",
    accountNumber: application.client.bankAccountNumber ?? "",
    branchCode: application.client.bankBranchCode ?? "",
    accountType: application.client.accountType ?? "",
  }
  if (
    Object.values(payoutProfile).some((value) => value.trim() === "")
    || application.verifiedBankStatements.length === 0
    || application.verifiedBankStatements.some((statement) =>
      !statement.documentId
      || !/^[0-9a-f]{64}$/.test(statement.documentSha256)
      || !Number.isFinite(statement.verifiedAt.getTime())
      || !statement.bankName
      || !statement.accountNumber
      || !statement.branchCode
      || !statement.accountType
    )
  ) {
    throw new Error("Reviewed outage bank evidence is incomplete")
  }

  const store = readAffordabilitySnapshotStore(application.affordabilityResult)
  const approval = store.approval
  if (
    !approval
    || approval.stage !== "APPROVAL"
    || !affordabilityDecisionSnapshotIsIntact(approval)
  ) {
    throw new Error("The intact approval calculator is missing")
  }

  // Driven by the policy rather than by the application id. An application that
  // reached agreement generation is bound by the CONTRACT calculator; one that
  // never did has only the APPROVAL calculator, and must not silently fall back
  // to approval while agreement evidence exists — that would book a loan on
  // different figures from the document the consumer holds.
  const calculatorSource: OutageReconciliationPlan["calculatorSource"] =
    policy.calculatorSource
  let calculator = approval.calculator
  if (calculatorSource === "CONTRACT") {
    if (
      !store.contract
      || !affordabilityContractEvidenceIsIntact(store.contract, approval)
      || !application.agreementDocumentId
    ) {
      throw new Error(
        "The reviewed application's intact contract calculator is missing",
      )
    }
    calculator = store.contract.calculator
  } else if (application.agreementDocumentId !== null) {
    throw new Error(
      "The reviewed application has agreement evidence but is policied to the approval calculator",
    )
  }

  const calculation = loanCalculationFromEvidence(calculator)
  const scheduleTotal = calculation.schedule.reduce(
    (sum, installment) => sum + installment.totalDue,
    0,
  )
  if (
    calculator.principalCents !== policy.principalCents
    || approval.inputs.principalCents !== policy.principalCents
    || approval.inputs.termDays !== policy.termDays
    || approval.inputs.interestRatePm !== policy.interestRatePm
    || calculation.principal !== policy.principalCents
    || calculation.totalRepayable !== scheduleTotal
    || calculation.schedule.length === 0
  ) {
    throw new Error("The calculator does not match the reviewed outage cohort")
  }

  const disbursedAt = normalizeSastDateOnly(policy.payoutDate)
  return {
    applicationId: application.id,
    applicationReference: application.reference,
    tenantId: application.tenantId,
    clientId: application.client.id,
    productId: application.productId,
    calculatorSource,
    incidentId: policy.incidentId,
    payoutDate: policy.payoutDate,
    disbursementRef: policy.disbursementRef,
    managementApprovedBy: policy.managementApprovedBy,
    calculatorPricingFingerprint: calculator.pricingFingerprint,
    calculatorContractFingerprint: calculator.contractFingerprint,
    calculation,
    monthlyServiceFee: approval.inputs.monthlyServiceFeeCents,
    disbursedAt,
    startDate: disbursedAt,
    maturityDate: calculation.schedule.at(-1)!.dueDate,
    nextPaymentDate: calculation.schedule[0].dueDate,
    agreementDocumentId: application.agreementDocumentId,
    waivedPreconditions: policy.waivedPreconditions,
    bankEvidence: {
      payoutProfile,
      verifiedStatements: application.verifiedBankStatements,
      exactStatementMatch: application.verifiedBankStatements.some(
        (statement) => exactBankMatch(statement, payoutProfile),
      ),
    },
  }
}

const outageApplicationQuery = Prisma.validator<
  Prisma.LoanApplicationDefaultArgs
>()({
  include: {
    client: {
      select: {
        id: true,
        bankName: true,
        bankAccountNumber: true,
        bankBranchCode: true,
        accountType: true,
      },
    },
    loan: { select: { id: true } },
    disbursementException: {
      select: {
        id: true,
        status: true,
        completedAt: true,
        data: true,
      },
    },
  },
})

type OutageApplicationRow = Prisma.LoanApplicationGetPayload<
  typeof outageApplicationQuery
>

const outageDocumentSelect = {
  id: true,
  docType: true,
  verified: true,
  verifiedAt: true,
  verificationRejectedById: true,
  contentSha256: true,
  extractionResult: true,
  createdAt: true,
} as const

type OutageDocumentRow = Prisma.ClientDocumentGetPayload<{
  select: typeof outageDocumentSelect
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function extractedField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null
  const fields = isRecord(value.fields) ? value.fields : value
  const candidate = fields[key]
  if (typeof candidate === "string" || typeof candidate === "number") {
    return String(candidate)
  }
  if (
    isRecord(candidate)
    && (
      typeof candidate.value === "string"
      || typeof candidate.value === "number"
    )
  ) {
    return String(candidate.value)
  }
  return null
}

function currentDocument(
  documents: readonly OutageDocumentRow[],
  docType: string,
): OutageDocumentRow | null {
  return documents
    .filter((document) => document.docType === docType)
    .reduce<OutageDocumentRow | null>((latest, document) => {
      if (!latest) return document
      const byDate = document.createdAt.getTime() - latest.createdAt.getTime()
      if (byDate !== 0) return byDate > 0 ? document : latest
      return document.id > latest.id ? document : latest
    }, null)
}

function documentsAreVerified(
  documents: readonly OutageDocumentRow[],
): boolean {
  return CORE_KYC_DOCUMENT_TYPES.every((docType) => {
    const document = currentDocument(documents, docType)
    return Boolean(
      document?.verified
      && document.verifiedAt
      && !document.verificationRejectedById
      && document.contentSha256
      && /^[0-9a-f]{64}$/.test(document.contentSha256),
    )
  })
}

async function loadOutageApplication(
  tx: ScopedTransactionClient,
  tenantId: string,
  applicationId: string,
): Promise<OutageLoadedApplication | null> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "LoanApplication"
    WHERE "tenantId" = ${tenantId}
      AND "id" = ${applicationId}
    FOR UPDATE
  `)
  if (locked.length !== 1) return null

  const application = await tx.loanApplication.findFirst({
    where: { id: applicationId, tenantId },
    ...outageApplicationQuery,
  }) as OutageApplicationRow | null
  if (!application) return null

  const documents = await tx.clientDocument.findMany({
    where: {
      tenantId,
      clientId: application.clientId,
      deletedAt: null,
      docType: {
        in: [...CORE_KYC_DOCUMENT_TYPES],
      },
    },
    select: outageDocumentSelect,
  })

  const verifiedBankStatements: OutageVerifiedBankStatement[] = documents
    .filter((document) =>
      document.docType === "BANK_STATEMENT"
      && document.verified
      && document.verifiedAt
      && document.contentSha256
      && /^[0-9a-f]{64}$/.test(document.contentSha256)
    )
    .flatMap((document) => {
      const bankName = extractedField(document.extractionResult, "bankName")
      const accountNumber =
        extractedField(document.extractionResult, "accountNumber")
      const branchCode = extractedField(document.extractionResult, "branchCode")
      const accountType =
        extractedField(document.extractionResult, "accountType")
      if (
        !document.verifiedAt
        || !document.contentSha256
        || !bankName
        || !accountNumber
        || !branchCode
        || !accountType
      ) {
        return []
      }
      return [{
        documentId: document.id,
        documentSha256: document.contentSha256,
        verifiedAt: document.verifiedAt,
        bankName,
        accountNumber,
        branchCode,
        accountType,
      }]
    })

  return {
    id: application.id,
    tenantId: application.tenantId,
    reference: application.reference,
    productId: application.productId,
    status: application.status,
    approvedAmount: application.approvedAmount,
    approvedTermDays: application.approvedTermDays,
    approvedRate: application.approvedRate,
    repaymentMethod: application.repaymentMethod,
    creditLifeElection: application.creditLifeElection,
    creditLifeProductId: application.creditLifeProductId,
    creditLifeInsurerId: application.creditLifeInsurerId,
    creditLifeMonthlyPremiumCents:
      application.creditLifeMonthlyPremiumCents,
    affordabilityResult: application.affordabilityResult,
    agreementDocumentId: application.agreementDocumentId,
    loan: application.loan,
    coreDocumentsVerified: documentsAreVerified(documents),
    client: {
      id: application.client.id,
      bankName: application.client.bankName,
      bankAccountNumber: application.client.bankAccountNumber,
      bankBranchCode: application.client.bankBranchCode,
      accountType: application.client.accountType,
    },
    verifiedBankStatements,
    disbursedAt: application.disbursedAt,
    disbursementExceptionId: application.disbursementExceptionId,
    disbursementException: application.disbursementException,
  }
}

const defaultDependencies: OutageReconciliationDependencies = {
  prisma,
  loadApplication: loadOutageApplication,
  recordCommission: async (tx, args) => {
    await recordDisbursementCommission(tx, args)
  },
  now: () => new Date(),
}

/**
 * Scoped to ONE incident, deliberately.
 *
 * Reconciliation is all-or-nothing across whatever this returns: if any member
 * is already reconciled and any other is not, it refuses as partial. Returning
 * every known application — which it used to, when there was only one incident —
 * would mean a newly added incident makes a settled cohort "partial" and
 * blocks it forever, while an unscoped apply would attempt to rewrite live loans.
 */
function reviewedApplicationIds(incidentId: string): string[] {
  return outageApplicationIdsForIncident(incidentId)
}

function partialOrConflicting(application: OutageLoadedApplication): boolean {
  return (
    application.status !== "APPROVED"
    || application.loan !== null
    || application.disbursedAt !== null
    || application.disbursementExceptionId !== null
    || application.disbursementException !== null
  )
}

function matchingCompletedReconciliation(
  application: OutageLoadedApplication,
): boolean {
  const evidence = parseOutageExceptionEvidence(
    application.disbursementException?.data,
  )
  const policy = outageApplicationPolicy(application.id)
  return Boolean(
    policy
    && application.status === "DISBURSED"
    && application.loan
    && application.disbursedAt
    && application.disbursedAt.getTime()
      === normalizeSastDateOnly(policy.payoutDate).getTime()
    && application.disbursementExceptionId
    && application.disbursementException
    && application.disbursementException.id
      === application.disbursementExceptionId
    && application.disbursementException.status === "COMPLETED"
    && application.disbursementException.completedAt
    && evidence
    && evidence.applicationId === application.id
    && evidence.applicationReference === application.reference
    && new Date(evidence.reconciledAt).getTime()
      === application.disbursementException.completedAt.getTime(),
  )
}

function jsonBankEvidence(plan: OutageReconciliationPlan) {
  return {
    payoutProfile: plan.bankEvidence.payoutProfile,
    exactStatementMatch: plan.bankEvidence.exactStatementMatch,
    verifiedStatements: plan.bankEvidence.verifiedStatements.map(
      (statement) => ({
        ...statement,
        verifiedAt: statement.verifiedAt.toISOString(),
      }),
    ),
  }
}

export async function reconcileOutageDisbursements(
  args: {
    tenantId: string
    incidentId: string
    operator: { id: string; email: string }
    managementApprovalNote: string
    apply: boolean
  },
  dependencies: OutageReconciliationDependencies = defaultDependencies,
): Promise<OutageReconciliationResult> {
  if (!isOutageIncidentId(args.incidentId)) {
    throw new Error("Unknown outage incident")
  }
  // Captured after the guard: narrowing on a parameter property does not survive
  // into the transaction closure below.
  const incidentId: OutageIncidentId = args.incidentId
  const applicationIds = reviewedApplicationIds(incidentId)
  const reconciledAt = dependencies.now()
  if (
    !args.tenantId
    || applicationIds.length === 0
    || !args.operator.id
    || !args.operator.email
    || !Number.isFinite(reconciledAt.getTime())
  ) {
    throw new Error("Outage reconciliation operator context is incomplete")
  }

  return dependencies.prisma.$transaction(async (tx) => {
    const applications: OutageLoadedApplication[] = []
    for (const applicationId of applicationIds) {
      const application = await dependencies.loadApplication(
        tx,
        args.tenantId,
        applicationId,
      )
      if (!application || application.tenantId !== args.tenantId) {
        throw new Error("Reviewed outage application is missing")
      }
      applications.push(application)
    }

    const completed = applications.map(matchingCompletedReconciliation)
    if (completed.every(Boolean)) {
      return {
        mode: "ALREADY_RECONCILED",
        incidentId,
        applications: applications.map((application) => ({
          ...buildOutageReconciliationPlan(
            {
              ...application,
              status: "APPROVED",
              loan: null,
            },
            OUTAGE_APPLICATIONS[
              application.id as keyof typeof OUTAGE_APPLICATIONS
            ],
          ),
          loanId: application.loan!.id,
          exceptionId: application.disbursementExceptionId!,
        })),
      }
    }
    if (completed.some(Boolean) || applications.some(partialOrConflicting)) {
      throw new Error(
        "A partial or conflicting outage reconciliation state was found",
      )
    }

    const plans = applications.map((application) =>
      buildOutageReconciliationPlan(
        application,
        OUTAGE_APPLICATIONS[
          application.id as keyof typeof OUTAGE_APPLICATIONS
        ],
      )
    )
    const exceptionEvidence = plans.map((plan) =>
      createOutageExceptionEvidence({
        applicationId:
          plan.applicationId as keyof typeof OUTAGE_APPLICATIONS,
        applicationReference: plan.applicationReference,
        managementApprovalNote: args.managementApprovalNote,
        reconciledById: args.operator.id,
        reconciledByEmail: args.operator.email,
        reconciledAt,
      })
    )
    if (!args.apply) {
      return {
        mode: "DRY_RUN",
        incidentId,
        applications: plans,
      }
    }

    const results: OutageReconciliationResult["applications"] = []
    for (const [index, plan] of plans.entries()) {
      const evidence = exceptionEvidence[index]
      const exception = await tx.complianceRecord.create({
        data: {
          tenantId: args.tenantId,
          type: "DISBURSEMENT_EXCEPTION",
          referenceId: plan.applicationId,
          idempotencyKey: `outage-disbursement:${plan.applicationId}`,
          status: "COMPLETED",
          completedAt: reconciledAt,
          data: evidence as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      })

      const claimed = await tx.loanApplication.updateMany({
        where: {
          id: plan.applicationId,
          tenantId: args.tenantId,
          status: "APPROVED",
          disbursementExceptionId: null,
          loan: null,
        },
        data: {
          status: "DISBURSED",
          disbursedAt: plan.disbursedAt,
          disbursementExceptionId: exception.id,
          disbursementBank: plan.bankEvidence.payoutProfile.bankName,
          disbursementAccountNo:
            plan.bankEvidence.payoutProfile.accountNumber,
          disbursementBranchCode:
            plan.bankEvidence.payoutProfile.branchCode,
          disbursementAccountType:
            plan.bankEvidence.payoutProfile.accountType,
          disbursementRef: outageDisbursementRef(plan),
        },
      })
      if (claimed.count !== 1) {
        throw new Error("Application changed during outage reconciliation")
      }

      const loan = await tx.loan.create({
        data: {
          tenantId: args.tenantId,
          reference: `LN-OUTAGE-${plan.applicationReference.slice(4)}`,
          applicationId: plan.applicationId,
          clientId: plan.clientId,
          productId: plan.productId,
          principal: plan.calculation.principal,
          totalInterest: plan.calculation.totalInterest,
          initiationFee: plan.calculation.initiationFee,
          creditLifePremiums: 0,
          totalRepayable: plan.calculation.totalRepayable,
          contractualTotalInterest: plan.calculation.totalInterest,
          contractualTotalRepayable: plan.calculation.totalRepayable,
          outstandingPrincipal: plan.calculation.principal,
          status: "ACTIVE",
          startDate: plan.startDate,
          maturityDate: plan.maturityDate,
          nextPaymentDate: plan.nextPaymentDate,
          interestRatePm: 0.05,
          interestModel: "DAILY_ACCRUAL",
          monthlyServiceFee: plan.monthlyServiceFee,
          agreementDocId: plan.agreementDocumentId,
        },
      })
      await tx.repaymentSchedule.createMany({
        data: plan.calculation.schedule.map((installment) => ({
          tenantId: args.tenantId,
          loanId: loan.id,
          installmentNo: installment.installmentNo,
          dueDate: installment.dueDate,
          principalDue: installment.principalDue,
          interestDue: installment.interestDue,
          creditLifePremiumDue: 0,
          feesDue: installment.feesDue,
          totalDue: installment.totalDue,
          status: "PENDING" as const,
        })),
      })
      await dependencies.recordCommission(tx, {
        tenantId: args.tenantId,
        loanId: loan.id,
        clientId: plan.clientId,
        principalCents: plan.calculation.principal,
      })

      const commonAuditEvidence = {
        incidentId,
        applicationId: plan.applicationId,
        applicationReference: plan.applicationReference,
        exceptionId: exception.id,
        actualPayoutDate: plan.payoutDate,
        timestampPrecision: "DATE",
        normalizedDisbursedAt: plan.disbursedAt.toISOString(),
        managementApprovedBy: plan.managementApprovedBy,
        managementApprovalNote: evidence.managementApprovalNote,
        reconciledById: args.operator.id,
        reconciledByEmail: args.operator.email.toLowerCase(),
        reconciledAt: reconciledAt.toISOString(),
        waivedPreconditions: [...plan.waivedPreconditions],
        duplicatePayoutSuppressed: true,
        calculatorSource: plan.calculatorSource,
        calculatorPricingFingerprint: plan.calculatorPricingFingerprint,
        calculatorContractFingerprint: plan.calculatorContractFingerprint,
        bankEvidence: jsonBankEvidence(plan),
      }
      await tx.auditLog.create({
        data: {
          tenantId: args.tenantId,
          userId: args.operator.id,
          userEmail: args.operator.email.toLowerCase(),
          action: AuditAction.LOAN_CREATED,
          entity: "Loan",
          entityId: loan.id,
          newValue: {
            ...commonAuditEvidence,
            loanReference: loan.reference,
            principal: plan.calculation.principal,
            totalInterest: plan.calculation.totalInterest,
            initiationFee: plan.calculation.initiationFee,
            serviceFees: plan.calculation.serviceFees,
            totalRepayable: plan.calculation.totalRepayable,
            scheduleItems: plan.calculation.schedule.length,
            maturityDate: plan.maturityDate.toISOString(),
          },
        },
      })
      await tx.auditLog.create({
        data: {
          tenantId: args.tenantId,
          userId: args.operator.id,
          userEmail: args.operator.email.toLowerCase(),
          action: AuditAction.OUTAGE_DISBURSEMENT_RECONCILED,
          entity: "LoanApplication",
          entityId: plan.applicationId,
          newValue: {
            ...commonAuditEvidence,
            loanId: loan.id,
            loanReference: loan.reference,
          },
        },
      })
      await tx.auditLog.create({
        data: {
          tenantId: args.tenantId,
          userId: args.operator.id,
          userEmail: args.operator.email.toLowerCase(),
          action: AuditAction.INSURANCE_AUTOBUNDLE_SKIPPED,
          entity: "Loan",
          entityId: loan.id,
          newValue: {
            ...commonAuditEvidence,
            reason: "declined_outage_reconciliation",
            creditLifeElection: "DECLINED",
            creditLifePremiums: 0,
          },
        },
      })
      results.push({
        ...plan,
        loanId: loan.id,
        exceptionId: exception.id,
      })
    }

    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    return {
      mode: "APPLIED",
      incidentId,
      applications: results,
    }
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  })
}

import { prisma } from "@/lib/prisma"
import type { Client, Loan, LoanApplication, Tenant } from "@prisma/client"
import { calculateLoan } from "@/lib/loan-calculator"
import { certificatePaidToDate, certificateSettlement, documentLoanFigures, loanSettlementFigures } from "@/lib/loan/charges-summary"
import { getLenderIdentity } from "@/lib/config/identity"
import { getLenderLogo } from "@/lib/config/lender-logo"
import { generateCreditAgreementPdf } from "@/lib/pdf/creditAgreement"
import { generateDebitMandatePdf } from "@/lib/pdf/debitMandate"
import { generateCertificateOfBalancePdf } from "@/lib/pdf/certificateOfBalance"
import { generateFaisDisclosurePdf } from "@/lib/pdf/faisDisclosure"
import { generateStatementPdf } from "@/lib/pdf/statement"
import { loadIssuedSection129Artifact } from "@/lib/collections/section129-artifact"
import { creditLifeAutoBundleDecision } from "@/lib/insurance/credit-life-containment"
import {
  assertDebitMandateCreditorTenant,
  getDebitMandateCreditorBankDetails,
} from "@/lib/config/debit-mandate"
import {
  debitMandatePaymentTerms,
  requireDebitMandateBankDetails,
} from "@/lib/loan/debit-mandate"
import { quotationValidUntilDateFromDatabase } from "@/lib/compliance/sa-business-calendar.server"

export type TemplateGenerationContext = {
  client: true
  application?: boolean
  loan?: boolean
}

export function isTemplateEligibleForContext(
  tokensUsed: unknown,
  context: TemplateGenerationContext,
): boolean {
  if (!Array.isArray(tokensUsed) || !tokensUsed.every((token) => typeof token === "string")) {
    return false
  }

  return tokensUsed.every(
    (token) =>
      (!token.startsWith("application.") || context.application) &&
      (!token.startsWith("loan.") || context.loan),
  )
}

/** Custom templates eligible for a generation action with the supplied context. */
export async function listGeneratableCustomTemplates(
  tenantId: string,
  context: TemplateGenerationContext,
) {
  const templates = await prisma.documentTemplate.findMany({
    where: {
      tenantId,
      kind: "CUSTOM",
      isActive: true,
      deletedAt: null,
      currentVersionId: { not: null },
    },
    orderBy: { name: "asc" },
    include: {
      versions: {
        where: { status: "ACTIVE" },
        select: { id: true, tokensUsed: true },
      },
    },
  })

  return templates.filter((template) => {
    const activeVersion = template.versions.find(
      (version) => version.id === template.currentVersionId,
    )
    return Boolean(activeVersion && isTemplateEligibleForContext(activeVersion.tokensUsed, context))
  })
}

/** Catalogue table for `/settings/documents` — mirrors its `Name` sort order. */
export async function listTemplates(tenantId: string) {
  return prisma.documentTemplate.findMany({
    where: { tenantId, deletedAt: null },
    orderBy: { name: "asc" },
    include: {
      versions: {
        where: { status: "ACTIVE" },
        select: { id: true },
      },
    },
  })
}

/**
 * Context for a SYSTEM document generator. `tenant`/`client` are always
 * present; `loan`/`application` are optional depending on which page the
 * "Generate document" action is invoked from (design §8). Adapters below
 * load any further relation they need (schedule, payments, product,
 * insurance policy) via `prisma`, explicitly scoped by `tenant.id`.
 */
export type SystemDocContext = {
  tenant: Tenant
  client: Client
  loan?: Loan | null
  application?: LoanApplication | null
}

/** Generators that print the lender's NCR number or legal identity read it
 * via `getLenderIdentity`, which throws `LenderIdentityError` when the tenant's
 * identity is not configured: the document is refused, never defaulted. */
export type SystemGenerator = (ctx: SystemDocContext) => Promise<Buffer>

/** Thrown by SYSTEM catalogue entries whose `lib/pdf` generator doesn't
 * exist yet (Pre-Agreement, Affordability Assessment — design §4 table). */
export class SystemGeneratorUnavailableError extends Error {
  constructor(key: string) {
    super(`No lib/pdf generator exists yet for SYSTEM document "${key}"`)
    this.name = "SystemGeneratorUnavailableError"
  }
}

async function creditAgreementAdapter(ctx: SystemDocContext): Promise<Buffer> {
  const application = ctx.application
  if (!application) {
    throw new Error("creditAgreement requires an application in the document context")
  }
  const product = await prisma.loanProduct.findUnique({
    where: { id: application.productId, tenantId: ctx.tenant.id },
  })
  if (!product) throw new Error(`LoanProduct ${application.productId} not found`)

  const calc = calculateLoan({
    principal: application.appliedAmount,
    termDays: application.appliedTermDays,
    interestRatePm: product.interestRatePm,
    interestModel: product.interestModel,
    initiationFeeModel: product.initiationFeeModel,
    initiationFeePct: product.initiationFeePct,
    initiationFeeMax: product.initiationFeeMax,
    monthlyServiceFee: product.monthlyServiceFee,
    productType: product.productType,
    initiationFeePayment: application.initiationFeePayment,
  })

  // A credit agreement recites that the consumer received and acknowledged
  // the quotation — this generator must not assert that on paper unless the
  // ceremony actually recorded it. Same gate as the agreement route.
  if (
    !application.pasqAcknowledgedAt
    || !application.pasqDocumentSha256
    || application.pasqAcknowledgedSha256 !== application.pasqDocumentSha256
  ) {
    throw new Error(
      "The credit agreement can only be generated once the consumer has acknowledged the current Pre-Agreement Statement & Quotation.",
    )
  }
  // The presented instant comes from the bound PASQ evidence — the same
  // value printed on the quotation the consumer acknowledged — never "now".
  const pasqCalculatorStartDate = (application.pasqEvidence as
    { calculator?: { startDate?: string } } | null)?.calculator?.startDate
  if (!pasqCalculatorStartDate) {
    throw new Error("The acknowledged PASQ evidence carries no presentation date.")
  }
  const quotePresentedAt = new Date(pasqCalculatorStartDate)

  // FOLLOW-UP before this adapter is ever wired live (it is unreachable
  // today — the only generateDocument caller passes allowSystem: false): the
  // figures below are RECOMPUTED from current product pricing with
  // startDate = now, not taken from the acknowledged PASQ evidence, so the
  // schedule dates always differ from the quotation and a post-PASQ
  // repricing would flow through undetected. The agreement route solves
  // this by rebasing through createAffordabilityContractEvidence and
  // 409-ing on drift — this adapter must do the same before exposure.
  const startDate = new Date()
  const maturityDate = new Date()
  maturityDate.setDate(maturityDate.getDate() + application.appliedTermDays)
  const quoteValidUntilDate = await quotationValidUntilDateFromDatabase(
    prisma,
    quotePresentedAt,
  )

  return generateCreditAgreementPdf({
    variant: "agreement",
    lender: await getLenderIdentity(ctx.tenant.id),
    logo: await getLenderLogo(ctx.tenant.id),
    client: {
      firstName: ctx.client.firstName,
      lastName: ctx.client.lastName,
      idNumber: ctx.client.idNumber,
      addressLine1: ctx.client.addressLine1 ?? undefined,
      city: ctx.client.city ?? undefined,
      suburb: ctx.client.suburb ?? undefined,
      province: ctx.client.province ?? undefined,
      postalCode: ctx.client.postalCode ?? undefined,
      phone: ctx.client.phone ?? undefined,
    },
    application: {
      reference: application.reference,
      agreementType: application.agreementType ?? undefined,
      appliedTermDays: application.appliedTermDays,
    },
    calc,
    product: {
      interestRatePm: product.interestRatePm,
      interestModel: product.interestModel,
      monthlyServiceFee: product.monthlyServiceFee,
    },
    startDate,
    maturityDate,
    quotePresentedAt,
    quoteValidUntilDate,
    // Interim compliance containment — must mirror the signed agreement and
    // disbursement paths. Missing configuration defaults to no auto-bundle.
    willAutoBundleCl: creditLifeAutoBundleDecision(application.appliedAmount).eligible,
    initiationFeePayment: application.initiationFeePayment,
  })
}

async function debitMandateAdapter(ctx: SystemDocContext): Promise<Buffer> {
  const loan = ctx.loan
  if (!loan) throw new Error("debitMandate requires a loan in the document context")

  const [schedule, application] = await Promise.all([
    prisma.repaymentSchedule.findMany({
      where: { loanId: loan.id, tenantId: ctx.tenant.id },
      orderBy: { installmentNo: "asc" },
      select: {
        installmentNo: true,
        dueDate: true,
        principalDue: true,
        interestDue: true,
        feesDue: true,
        totalDue: true,
      },
    }),
    prisma.loanApplication.findUnique({
      where: { id: loan.applicationId, tenantId: ctx.tenant.id },
      select: { initiationFeePayment: true, affordabilityResult: true },
    }),
  ])
  if (!application) throw new Error(`LoanApplication ${loan.applicationId} not found`)
  const bankDetails = requireDebitMandateBankDetails(ctx.client)
  const paymentTerms = debitMandatePaymentTerms({
    schedule,
    principal: loan.principal,
    totalInterest: loan.totalInterest,
    totalRepayable: loan.totalRepayable,
    initiationFee: loan.initiationFee,
    initiationFeePayment: application.initiationFeePayment,
    startDate: loan.startDate,
    maturityDate: loan.maturityDate,
    affordabilityResult: application.affordabilityResult,
  })
  assertDebitMandateCreditorTenant(ctx.tenant.id)
  const creditorBankDetails = getDebitMandateCreditorBankDetails()

  const identity = await getLenderIdentity(ctx.tenant.id)

  return generateDebitMandatePdf({
    lender: identity,
    logo: await getLenderLogo(ctx.tenant.id),
    creditorBank: creditorBankDetails,
    client: {
      firstName: ctx.client.firstName,
      lastName: ctx.client.lastName,
      idNumber: ctx.client.idNumber,
      phone: ctx.client.phone ?? undefined,
      email: ctx.client.email ?? undefined,
      ...bankDetails,
    },
    loan: {
      reference: loan.reference,
      ...paymentTerms,
    },
  })
}

async function section129Adapter(ctx: SystemDocContext): Promise<Buffer> {
  const loan = ctx.loan
  if (!loan) throw new Error("section129 requires a loan in the document context")
  const artifact = await loadIssuedSection129Artifact({
    tenantId: ctx.tenant.id,
    loanId: loan.id,
  })
  return artifact.pdf
}

async function certificateOfBalanceAdapter(ctx: SystemDocContext): Promise<Buffer> {
  const loan = ctx.loan
  if (!loan) throw new Error("certificateOfBalance requires a loan in the document context")

  const repaymentSchedule = await prisma.repaymentSchedule.findMany({
    where: { loanId: loan.id, tenantId: ctx.tenant.id },
    orderBy: { dueDate: "asc" },
  })
  const figures = await loanSettlementFigures(prisma, { ...loan, repaymentSchedule }, new Date())

  return generateCertificateOfBalancePdf({
    lender: await getLenderIdentity(ctx.tenant.id),
    logo: await getLenderLogo(ctx.tenant.id),
    client: {
      firstName: ctx.client.firstName,
      lastName: ctx.client.lastName,
      idNumber: ctx.client.idNumber,
      addressLine1: ctx.client.addressLine1 ?? undefined,
      city: ctx.client.city ?? undefined,
    },
    loan: {
      reference: loan.reference,
      startDate: loan.startDate,
      maturityDate: loan.maturityDate,
      principal: loan.principal,
      totalPaid: loan.totalPaid,
      // Zero for a loan CANCELLED by a disbursement reversal (nothing owed).
      ...documentLoanFigures(loan),
      // Charge-inclusive, as on the Section 129 notice.
      arrearsAmount: figures.arrearsIncludingCharges,
      interestRatePm: loan.interestRatePm,
      lastPaymentDate: loan.lastPaymentDate,
      lastPaymentAmount: loan.lastPaymentAmount,
    },
    settlement: certificateSettlement(figures),
    paymentsReceived: certificatePaidToDate(figures),
  })
}

async function statementAdapter(ctx: SystemDocContext): Promise<Buffer> {
  const loan = ctx.loan
  if (!loan) throw new Error("statement requires a loan in the document context")

  const [product, schedule, payments] = await Promise.all([
    prisma.loanProduct.findUnique({
      where: { id: loan.productId, tenantId: ctx.tenant.id },
      select: { name: true },
    }),
    prisma.repaymentSchedule.findMany({
      where: { loanId: loan.id, tenantId: ctx.tenant.id },
      orderBy: { installmentNo: "asc" },
    }),
    prisma.payment.findMany({
      where: { loanId: loan.id, tenantId: ctx.tenant.id },
      orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }],
    }),
  ])
  if (!product) throw new Error(`LoanProduct ${loan.productId} not found`)
  const figures = await loanSettlementFigures(prisma, { ...loan, repaymentSchedule: schedule }, new Date())

  return generateStatementPdf({
    lender: await getLenderIdentity(ctx.tenant.id),
    logo: await getLenderLogo(ctx.tenant.id),
    client: {
      firstName: ctx.client.firstName,
      lastName: ctx.client.lastName,
      idNumber: ctx.client.idNumber,
      email: ctx.client.email,
      addressLine1: ctx.client.addressLine1 ?? undefined,
      city: ctx.client.city ?? undefined,
    },
    loan: {
      id: loan.id,
      reference: loan.reference,
      principal: loan.principal,
      totalPaid: loan.totalPaid,
      interestRatePm: loan.interestRatePm,
      interestModel: loan.interestModel,
      status: loan.status,
      startDate: loan.startDate,
      maturityDate: loan.maturityDate,
      // Zero for a loan CANCELLED by a disbursement reversal (nothing owed).
      ...documentLoanFigures(loan),
      // Charge-inclusive, as on the Section 129 notice.
      arrearsAmount: figures.arrearsIncludingCharges,
    },
    product: { name: product.name },
    schedule: schedule.map((s) => ({
      installmentNo: s.installmentNo,
      dueDate: s.dueDate,
      totalDue: s.totalDue,
      totalPaid: s.totalPaid,
      status: s.status,
    })),
    payments: payments.map((p) => ({
      createdAt: p.createdAt,
      receivedAt: p.receivedAt,
      amount: p.amount,
      paymentMethod: p.paymentMethod,
      reference: p.reference,
      reversed: p.reversed,
      reversedAt: p.reversedAt,
      reversalReason: p.reversalReason,
      allocationStatus: p.allocationStatus,
      reconciliationReason: p.reconciliationReason,
      defaultInterestAllocated: p.defaultInterestAllocated,
      chargeFeesAllocated: p.chargeFeesAllocated,
    })),
    charges: figures.charges
      ? { postings: figures.charges.postings, outstanding: figures.chargesOutstanding, settlement: figures.totalToSettle }
      : undefined,
  })
}

// InsurancePolicy isn't part of SystemDocContext, so this adapter loads the
// client's most recent policy directly, narrowed to the loan when present.
async function faisDisclosureAdapter(ctx: SystemDocContext): Promise<Buffer> {
  const policy = await prisma.insurancePolicy.findFirst({
    where: {
      tenantId: ctx.tenant.id,
      clientId: ctx.client.id,
      ...(ctx.loan ? { linkedLoanId: ctx.loan.id } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: { advisor: true, product: true, insurer_rel: true },
  })
  if (!policy) throw new Error(`No insurance policy found for client ${ctx.client.id}`)

  return generateFaisDisclosurePdf({
    lender: await getLenderIdentity(ctx.tenant.id),
    logo: await getLenderLogo(ctx.tenant.id),
    client: {
      firstName: ctx.client.firstName,
      lastName: ctx.client.lastName,
      idNumber: ctx.client.idNumber,
    },
    advisor: {
      name: policy.advisor?.name ?? policy.advisor?.email ?? "—",
      // No advisor job-title field on User; mirrors the literal used by the
      // only other FAIS-disclosure call site instead of inventing a value.
      designation: "Insurance Officer",
    },
    product: {
      type: policy.type,
      name: policy.product?.name ?? policy.type,
      insurer: policy.insurer_rel?.name ?? policy.insurer ?? undefined,
    },
    policyDraft: {
      sumAssured: policy.sumAssured.toNumber(),
      premiumAmount: policy.premiumAmount.toNumber(),
    },
  })
}

const preAgreementAdapter: SystemGenerator = async () => {
  throw new SystemGeneratorUnavailableError("preAgreement")
}

const affordabilityAssessmentAdapter: SystemGenerator = async () => {
  throw new SystemGeneratorUnavailableError("affordabilityAssessment")
}

/** Keyed by `DocumentTemplate.systemGenerator` (seeded in
 * prisma/seed-document-templates.ts). */
export const SYSTEM_GENERATORS: Record<string, SystemGenerator> = {
  creditAgreement: creditAgreementAdapter,
  preAgreement: preAgreementAdapter,
  debitMandate: debitMandateAdapter,
  section129: section129Adapter,
  certificateOfBalance: certificateOfBalanceAdapter,
  faisDisclosure: faisDisclosureAdapter,
  statement: statementAdapter,
  affordabilityAssessment: affordabilityAssessmentAdapter,
}

import { Prisma, type AgreementType, type AppStatus, type LoanPurposeCategory } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { ApplicationSubmissionTransaction } from "@/lib/applications/submission-lock"
import { validateAllApplication, type ValidationErrors } from "@/lib/validation/application-wizard"
import { toApplicationProduct } from "@/lib/applications/product-mapper"
import { creditBlock } from "@/lib/clients/status"
import type { ApplicationProduct, ApplicationWizardData } from "@/components/applications/wizard/types"
import {
  AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
  affordabilityExpenseEvidenceNeedsMleJustification,
  affordabilityExpenseEvidenceIsIntact,
  createAffordabilityExpenseEvidence,
  createSubmissionAffordabilitySnapshot,
  withAffordabilitySnapshot,
} from "@/lib/affordability/snapshot"
import {
  CREDIT_LIFE_DISCLOSURE_VERSION,
  CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
  calculateCreditLifeMonthlyPremiumCents,
  creditLifeOfferMatches,
  isCreditLifeElection,
} from "@/lib/insurance/credit-life-election"
import {
  createCreditLifeDisclosureSha256,
  createCreditLifeNoOfferDisclosureSha256,
} from "@/lib/insurance/credit-life-election.server"
import { creditLifeOfferFindFirstArgs } from "@/lib/insurance/credit-life-offer"
import { creditLifeAutoBundleDecision } from "@/lib/insurance/credit-life-containment"

export type PrepareApplicationInput = Omit<ApplicationWizardData, "appliedAmount" | "appliedTermDays"> & {
  appliedAmount: number // cents (wizard coerces to cents before POST/PATCH)
  appliedTermDays: number
  creditLifeProductId?: unknown
  creditLifeProductName?: unknown
  creditLifeInsurerId?: unknown
  creditLifeInsurerName?: unknown
  creditLifeMonthlyPremiumCents?: unknown
  creditLifeDisclosureVersion?: unknown
}

interface DebtSnapshotEntry {
  sourceId: string
  provider: string
  type: string
  balance: number
  monthlyInstalment: number
  notes: string | null
}

export interface PreparedApplicationFields {
  clientId: string
  productId: string
  appliedAmount: number
  appliedTermDays: number
  purpose: string | null
  loanPurposeCategory: LoanPurposeCategory | null
  agreementType: AgreementType
  existingDebtObligations: DebtSnapshotEntry[]
  totalExistingDebt: number
  netDisposableIncome: number
  affordabilityNDI: number
  affordabilityResult: Prisma.InputJsonValue
  status: AppStatus
  submittedAt: Date | null
  clientAffordabilityDeclaredAt?: Date
  recklessLendingAssessed?: boolean
  recklessLendingAssessedAt?: Date
  recklessLendingAssessedById?: string
  creditLifeElection?: "ACCEPTED" | "DECLINED"
  creditLifeProductId?: string | null
  creditLifeProductName?: string | null
  creditLifeInsurerId?: string | null
  creditLifeInsurerName?: string | null
  creditLifeMonthlyPremiumCents?: number
  creditLifeDisclosureVersion?: string
  creditLifeDisclosureSha256?: string
  creditLifeDisclosureAcknowledgedAt?: Date
  creditLifeDisclosureAcknowledgedBy?: string
}

export type PrepareApplicationResult =
  | { ok: true; fields: PreparedApplicationFields }
  | {
      ok: false
      status: 400 | 404 | 409 | 422
      body: { error: string; errors?: ValidationErrors<ApplicationWizardData> }
    }

function classifyAgreementType(amountCents: number): AgreementType {
  if (amountCents <= 1_500_000) return "SMALL"
  if (amountCents <= 25_000_000) return "INTERMEDIATE"
  return "LARGE"
}

/**
 * Shared business logic behind both the application-create (POST) and
 * draft-update (PATCH) paths: server-side validation against active
 * products, the defaulted-loan block, and the NDI/affordability snapshot.
 * `opts.action` only changes the defaulted-loan error copy ("create" vs
 * "update") — the create path's copy must stay byte-identical to preserve
 * existing API responses.
 */
export async function prepareApplicationFields(
  data: PrepareApplicationInput,
  tenantId: string,
  userId: string,
  opts: { action: "create" | "update" },
  database?: ApplicationSubmissionTransaction,
): Promise<PrepareApplicationResult> {
  const db = database ?? prisma
  // Load active products for server-side validation
  const activeProductRows = await db.loanProduct.findMany({
    where: { tenantId, active: true },
    select: {
      id: true,
      name: true,
      code: true,
      minAmount: true,
      maxAmount: true,
      minTermDays: true,
      maxTermDays: true,
      interestRatePm: true,
      interestModel: true,
      initiationFeeModel: true,
      initiationFeePct: true,
      initiationFeeMax: true,
      monthlyServiceFee: true,
      productType: true,
    },
  })

  const activeProducts: ApplicationProduct[] = activeProductRows.map(toApplicationProduct)

  // Server-side validation — mirrors per-step client-side rules
  // Note: appliedAmount arrives as cents (Int) after wizard coercion, but
  // the wizard data type stores it as a rand string for client-side display.
  // Re-shape to the string form validateAllApplication expects so the
  // amount/term range checks work correctly against product bounds.
  const centsToDec = (cents: number) => String(cents / 100)
  const validationPayload: ApplicationWizardData = {
    ...data,
    appliedAmount: typeof data.appliedAmount === "number"
      ? centsToDec(data.appliedAmount)
      : String(data.appliedAmount),
    appliedTermDays: String(data.appliedTermDays),
  }

  // Resolved before validation: with no active credit-life product there is no
  // cover to offer, so the wizard cannot have captured an election or a
  // disclosure acknowledgement and validation must not demand them.
  const configuredCreditLifeOffer = data.submitForReview
    ? await db.insuranceProduct.findFirst(creditLifeOfferFindFirstArgs(tenantId))
    : null

  const validationErrors = validateAllApplication(
    validationPayload,
    activeProducts,
    {
      forReview: Boolean(data.submitForReview),
      creditLifeOffered: configuredCreditLifeOffer !== null,
    },
  )
  if (Object.keys(validationErrors).length > 0) {
    return { ok: false, status: 400, body: { error: "Validation failed", errors: validationErrors } }
  }

  // Fetch client financial data for NDI calculations
  const client = await db.client.findUnique({
    where: { id: data.clientId, tenantId },
    include: { debtObligations: true, expenseBreakdown: true },
  })

  if (!client) {
    return { ok: false, status: 404, body: { error: "Client not found" } }
  }

  // A client recorded as deceased, or blacklisted, cannot take on new credit.
  //
  // This is the authorization for staff origination. The picker at
  // app/(dashboard)/applications/new omits both from its dropdown, but that is
  // a convenience: POST /api/applications accepts any clientId, so before this
  // the filtered <select> was the only thing standing between a caller and an
  // application for a blacklisted client.
  //
  // Checked BEFORE the defaulted-loan query below on purpose — "resolve the
  // default first" is the wrong instruction to give about someone who has
  // died, and the query is wasted work once the answer is already no.
  const block = creditBlock(client)
  if (block.blocked) {
    return {
      ok: false,
      status: 422,
      body: {
        error: block.reason === "DECEASED"
          ? "This client is recorded as deceased. A new credit agreement cannot be opened."
          : "This client is blacklisted. A new credit agreement cannot be opened.",
      },
    }
  }

  // Block new applications if client has a defaulted loan
  const hasDefault = await db.loan.findFirst({
    where: { clientId: data.clientId, tenantId, status: "DEFAULTED" },
    select: { id: true },
  })
  if (hasDefault) {
    return {
      ok: false,
      status: 422,
      body: {
        error: opts.action === "update"
          ? "Cannot update application: Client has a defaulted loan account. This must be resolved before a new application can be accepted."
          : "Cannot create application: Client has a defaulted loan account. This must be resolved before a new application can be accepted.",
      },
    }
  }

  const totalExistingDebt = client.debtObligations.reduce(
    (sum, d) => sum + d.monthlyInstalment, 0
  )
  const netDisposableIncome = client.monthlyIncome - client.monthlyExpenses - totalExistingDebt

  // Persist the exact server-side submission inputs, rather than only the NDI
  // output. Client financials and product pricing are mutable master data; an
  // application must retain the evidence on which it was submitted.
  const selectedProduct = activeProducts.find((product) => product.id === data.productId)
  if (!selectedProduct) {
    // validateAllApplication already rejects this. Keep a defensive fail-closed
    // branch in case the validator contract changes independently.
    return {
      ok: false,
      status: 400,
      body: { error: "Validation failed", errors: { productId: "Select a valid active product" } },
    }
  }

  // Snapshot debt obligations as JSON
  const debtSnapshot: DebtSnapshotEntry[] = client.debtObligations.map((d) => ({
    sourceId: d.id,
    provider: d.creditProvider,
    type: d.accountType,
    balance: d.outstandingBalance,
    monthlyInstalment: d.monthlyInstalment,
    notes: d.notes,
  }))

  const now = new Date()
  const isSubmitting = Boolean(data.submitForReview)
  let creditLifeEvidence: {
    election: "ACCEPTED" | "DECLINED"
    version:
      | typeof CREDIT_LIFE_DISCLOSURE_VERSION
      | typeof CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION
    // Null together, and only when no cover was offered.
    productId: string | null
    productName: string | null
    insurerId: string | null
    insurerName: string | null
    monthlyPremiumCents: number
    disclosureSha256: string
  } | null = null
  if (isSubmitting) {
    // Only a real offer creates something to elect on and acknowledge. With
    // none configured the wizard renders no election block at all, so
    // demanding one here would reject every submission.
    if (
      configuredCreditLifeOffer
      && (!isCreditLifeElection(data.creditLifeElection) || !data.creditLifeDisclosureAcknowledged)
    ) {
      return {
        ok: false,
        status: 422,
        body: { error: "Cannot submit for review: the credit-life election and disclosure acknowledgement are required." },
      }
    }
    const creditLifeAvailability = creditLifeAutoBundleDecision(data.appliedAmount)
    if (data.creditLifeElection === "ACCEPTED" && !creditLifeAvailability.eligible) {
      return {
        ok: false,
        status: 422,
        body: {
          error: "Cannot submit for review: credit-life cover is not available for this application. Record the client's decision to proceed without cover.",
        },
      }
    }
    // No active credit-life product with an active insurer means there was no
    // cover to offer, so there is nothing to decline against. Record the
    // no-offer disclosure instead of rejecting the submission — requiring an
    // offer here is what made every application unsubmittable.
    if (!configuredCreditLifeOffer) {
      if (data.creditLifeElection === "ACCEPTED") {
        return {
          ok: false,
          status: 422,
          body: {
            error: "Cannot submit for review: no credit-life product is configured, so cover cannot be added.",
          },
        }
      }
      // The client echoed an offer that no longer resolves. Refuse rather than
      // silently downgrade a real disclosure into a no-offer one.
      if (data.creditLifeProductId != null || data.creditLifeInsurerId != null) {
        return {
          ok: false,
          status: 409,
          body: {
            error: "The credit-life offer changed before submission. Refresh and present the current product, insurer, and exact premium before acknowledging the PASQ.",
          },
        }
      }
      creditLifeEvidence = {
        election: "DECLINED",
        version: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
        productId: null,
        productName: null,
        insurerId: null,
        insurerName: null,
        monthlyPremiumCents: 0,
        disclosureSha256: createCreditLifeNoOfferDisclosureSha256({
          version: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
          election: "DECLINED",
          principalCents: data.appliedAmount,
          termDays: data.appliedTermDays,
        }),
      }
    } else if (typeof data.creditLifeProductId !== "string") {
      // An offer exists but the submission carries none — the client rendered a
      // stale no-offer screen. Recording "no cover offered" here would assert
      // something untrue about an application where cover WAS available.
      return {
        ok: false,
        status: 409,
        body: {
          error: "Credit-life cover became available before submission. Refresh the application and present the current offer.",
        },
      }
    }
    if (!creditLifeEvidence) {
    const electedOption = data.creditLifeElection
    if (!isCreditLifeElection(electedOption)) {
      return {
        ok: false,
        status: 422,
        body: { error: "Cannot submit for review: the credit-life election and disclosure acknowledgement are required." },
      }
    }
    if (typeof data.creditLifeProductId !== "string") {
      return {
        ok: false,
        status: 422,
        body: { error: "Cannot submit for review: the disclosed credit-life offer is incomplete." },
      }
    }
    await db.$queryRaw(Prisma.sql`
      SELECT product."id"
      FROM "InsuranceProduct" AS product
      JOIN "Insurer" AS insurer
        ON insurer."id" = product."insurerId"
        AND insurer."tenantId" = product."tenantId"
      WHERE product."id" = ${data.creditLifeProductId}
        AND product."tenantId" = ${tenantId}
        AND product."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
        AND product."active" = TRUE
        AND insurer."tenantId" = ${tenantId}
        AND insurer."active" = TRUE
      FOR SHARE OF product, insurer
    `)
    const creditLifeProduct = await db.insuranceProduct.findFirst({
      where: {
        id: data.creditLifeProductId,
        tenantId,
        type: "CREDIT_LIFE",
        active: true,
        insurerId: { not: null },
        insurer: {
          is: {
            tenantId,
            active: true,
          },
        },
      },
      select: {
        id: true,
        name: true,
        insurerId: true,
        insurer: {
          select: {
            id: true,
            tenantId: true,
            active: true,
            name: true,
          },
        },
      },
    })
    if (
      !creditLifeProduct?.insurerId
      || !creditLifeProduct.insurer
      || creditLifeProduct.insurer.id !== creditLifeProduct.insurerId
      || creditLifeProduct.insurer.tenantId !== tenantId
      || !creditLifeProduct.insurer.active
      || creditLifeProduct.name.trim() === ""
      || creditLifeProduct.insurer.name.trim() === ""
    ) {
      return {
        ok: false,
        status: 422,
        body: { error: "Cannot submit for review: the disclosed credit-life product or insurer is no longer available. Refresh the application and present the current offer." },
      }
    }
    const monthlyPremiumCents = calculateCreditLifeMonthlyPremiumCents(data.appliedAmount)
    const offer = {
      productId: creditLifeProduct.id,
      productName: creditLifeProduct.name,
      insurerId: creditLifeProduct.insurerId,
      insurerName: creditLifeProduct.insurer.name,
      monthlyPremiumCents,
    }
    if (!creditLifeOfferMatches({
      productId: data.creditLifeProductId,
      productName: data.creditLifeProductName,
      insurerId: data.creditLifeInsurerId,
      insurerName: data.creditLifeInsurerName,
      monthlyPremiumCents: data.creditLifeMonthlyPremiumCents,
      version: data.creditLifeDisclosureVersion,
    }, offer)) {
      return {
        ok: false,
        status: 409,
        body: { error: "The credit-life offer changed before submission. Refresh and present the current product, insurer, and exact premium before acknowledging the PASQ." },
      }
    }
    creditLifeEvidence = {
      election: electedOption,
      version: CREDIT_LIFE_DISCLOSURE_VERSION,
      ...offer,
      disclosureSha256: createCreditLifeDisclosureSha256({
        version: CREDIT_LIFE_DISCLOSURE_VERSION,
        election: electedOption,
        principalCents: data.appliedAmount,
        termDays: data.appliedTermDays,
        ...offer,
      }),
    }
    }
  }
  const expenseEvidence = createAffordabilityExpenseEvidence(client)
  if (isSubmitting && affordabilityExpenseEvidenceNeedsMleJustification(expenseEvidence)) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "Cannot submit for review: declared living expenses are below the Regulation 23A minimum and require a documented justification on the client expense record.",
      },
    }
  }
  if (isSubmitting && !affordabilityExpenseEvidenceIsIntact(expenseEvidence)) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "Cannot submit for review: the client's scalar and itemised expense evidence is incomplete or inconsistent.",
      },
    }
  }
  const submissionSnapshot = createSubmissionAffordabilitySnapshot({
    capturedAt: now,
    capturedById: userId,
    client,
    applicationDebts: debtSnapshot,
    clientDebts: client.debtObligations,
    application: {
      appliedAmount: data.appliedAmount,
      appliedTermDays: data.appliedTermDays,
      productId: selectedProduct.id,
      initiationFeePayment: "DEFERRED",
      creditLifeMonthlyPremiumCents:
        creditLifeEvidence?.election === "ACCEPTED"
          ? creditLifeEvidence.monthlyPremiumCents
          : 0,
    },
    product: {
      interestRatePm: selectedProduct.interestRatePm,
      productType: selectedProduct.productType,
      interestModel: selectedProduct.interestModel,
      initiationFeeModel: selectedProduct.initiationFeeModel,
      initiationFeePct: selectedProduct.initiationFeePct,
      initiationFeeMax: selectedProduct.initiationFeeMax,
      monthlyServiceFee: selectedProduct.monthlyServiceFee,
    },
  })

  return {
    ok: true,
    fields: {
      clientId: data.clientId,
      productId: data.productId,
      appliedAmount: data.appliedAmount,
      appliedTermDays: data.appliedTermDays,
      purpose: data.purpose || null,
      // Wizard string → Prisma enum. The wizard dropdown values are
      // constrained to the same labels as the Prisma `LoanPurposeCategory`
      // enum (see prisma/schema/applications.prisma); the cast asserts that
      // alignment rather than introducing a new freedom.
      loanPurposeCategory: (data.loanPurposeCategory || null) as LoanPurposeCategory | null,
      agreementType: classifyAgreementType(data.appliedAmount),
      existingDebtObligations: debtSnapshot,
      totalExistingDebt,
      netDisposableIncome,
      // `affordabilityNDI` is the post-proposed-loan disposable income used by
      // decisioning, not the pre-loan NDI retained in `netDisposableIncome`.
      affordabilityNDI: submissionSnapshot.outcome.ndiAfterLoanCents,
      affordabilityResult: (isSubmitting
        ? withAffordabilitySnapshot(null, submissionSnapshot)
        : { schemaVersion: AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION }) as unknown as Prisma.InputJsonValue,
      status: isSubmitting ? "SUBMITTED" : "DRAFT",
      submittedAt: isSubmitting ? now : null,
      ...(isSubmitting && data.affordabilityDeclared && {
        clientAffordabilityDeclaredAt: now,
      }),
      ...(isSubmitting && creditLifeEvidence && {
        creditLifeElection: creditLifeEvidence.election,
        creditLifeProductId: creditLifeEvidence.productId,
        creditLifeProductName: creditLifeEvidence.productName,
        creditLifeInsurerId: creditLifeEvidence.insurerId,
        creditLifeInsurerName: creditLifeEvidence.insurerName,
        creditLifeMonthlyPremiumCents: creditLifeEvidence.monthlyPremiumCents,
        creditLifeDisclosureVersion: creditLifeEvidence.version,
        creditLifeDisclosureSha256: creditLifeEvidence.disclosureSha256,
        creditLifeDisclosureAcknowledgedAt: now,
        // This is the consumer's legal acknowledgement. Staff who capture the
        // election remain the authenticated actor in the surrounding audit
        // record and affordability/reckless-lending witness fields.
        creditLifeDisclosureAcknowledgedBy: client.id,
      }),
      ...(isSubmitting && data.recklessLendingConfirmed && {
        recklessLendingAssessed: true,
        recklessLendingAssessedAt: now,
        recklessLendingAssessedById: userId,
      }),
    },
  }
}

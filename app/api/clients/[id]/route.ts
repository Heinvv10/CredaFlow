import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import { resolveReferralCodeById } from "@/lib/referral-agents/referrals"
import { planReferralUpdate } from "@/lib/clients/referral-update"
import { recordDisbursementCommission } from "@/lib/referral-agents/commission"
import {
  describeRetroBlockers,
  describeRetroPreviewMismatch,
  type RetroPlan,
  type RetroPreviewTotals,
} from "@/lib/referral-agents/retro-attribution"
import {
  loadRetroAttributionPlan,
  applyRetroAttribution,
} from "@/lib/referral-agents/retro-attribution-apply"
import { requireApiRole } from "@/lib/auth-guards"
import { ACCOUNT_TYPE_VALUES } from "@/lib/validation/client-wizard"
import { withTenantContext } from "@/lib/tenant"
import { minimumLivingExpense } from "@/lib/affordability/mle"
import { sumExpenseBreakdown } from "@/lib/affordability/sum-expense-breakdown"
import { syncClientConsent } from "@/lib/consent"
import { Prisma } from "@prisma/client"
import { lockAffordabilityClientEvidence } from "@/lib/affordability/evidence-locks"
import { bankEvidenceAuditValue } from "@/lib/compliance/bank-evidence"
import {
  clientKycAuditValue,
  readCompositeKycState,
  type CompositeKycReader,
} from "@/lib/kyc/document-state"
import { updateClientWithBiometricIdentityRevocation } from "@/lib/kyc/identity-revocation"
import type { BankAccountType } from "@prisma/client"


/**
 * Narrow a validated account type for the Prisma enum column.
 *
 * A guard rather than an `as` cast: the raw `data.accountType` type-checked
 * only because `data` is `any`, which is exactly how an unvalidated string
 * reached a Prisma enum column in the first place. This makes the compiler
 * demand the allow-list check before the value can be written.
 */
function isBankAccountType(value: string): value is BankAccountType {
  return ACCOUNT_TYPE_VALUES.has(value)
}

class ClientFinancialValidationError extends Error {
  constructor(
    message: string,
    readonly errors: Record<string, string>,
  ) {
    super(message)
    this.name = "ClientFinancialValidationError"
  }
}

/** Re-pointing referral commission needs LOAN_ADMIN (lib/clients/referral-update). */
class ClientReferralForbiddenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ClientReferralForbiddenError"
  }
}

class ClientUpdateNotFoundError extends Error {
  constructor() {
    super("Client not found")
    this.name = "ClientUpdateNotFoundError"
  }
}

/**
 * The commission totals an operator saw in the confirmation, echoed back so the
 * write can refuse to differ from them. OPTIONAL — an API caller that never
 * previewed is not broken — but enforced whenever it is present, which is why a
 * malformed value is a 400 rather than a silent skip.
 */
function parseReferralImpactApproval(value: unknown): RetroPreviewTotals {
  const isCents = (candidate: unknown): candidate is number =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    !isCents((value as RetroPreviewTotals).totalAccrueCents) ||
    !isCents((value as RetroPreviewTotals).totalReverseCents)
  ) {
    throw new ClientFinancialValidationError("Validation failed", {
      referralImpact: "Must carry totalAccrueCents and totalReverseCents as non-negative integers",
    })
  }
  const { totalAccrueCents, totalReverseCents } = value as RetroPreviewTotals
  return { totalAccrueCents, totalReverseCents }
}

/** A re-attribution whose retroactive accrual cannot be applied safely. */
class ClientReferralBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ClientReferralBlockedError"
  }
}

/** An edit that would break an intact approval's bound decision evidence. */
class ClientApprovalEvidenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ClientApprovalEvidenceError"
  }
}

class ClientStaleUpdateError extends Error {
  constructor() {
    super("Client data changed after this edit form was opened. Refresh and re-apply the intended changes.")
    this.name = "ClientStaleUpdateError"
  }
}

/**
 * The figures the APPROVAL was actually decided on, read from the immutable
 * snapshot. Income and declared expenses both feed the decision fingerprint
 * (lib/affordability/snapshot.ts hashes statedMonthlyExpensesCents and every
 * breakdown category alongside income), and neither has a recovery path short
 * of a fresh approval.
 *
 * Returns null per field when the snapshot is absent or malformed, so an
 * unreadable snapshot never blocks an edit — it is already unusable evidence and
 * the application must be re-approved regardless.
 */
function approvalDecisionEvidence(affordabilityResult: unknown): {
  monthlyIncomeCents: number | null
  grossMonthlyIncomeCents: number | null
  monthlyExpensesCents: number | null
  breakdown: ExpenseBreakdownAmounts | null
} {
  const store = affordabilityResult as
    | { approval?: {
        inputs?: Record<string, unknown>
        expenses?: Record<string, unknown> & { breakdown?: Record<string, unknown> }
      } }
    | null
  const asCents = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null
  const rawBreakdown = store?.approval?.expenses?.breakdown
  const breakdown = EXPENSE_BREAKDOWN_AMOUNT_FIELDS
    .every((field) => asCents(rawBreakdown?.[field]) !== null)
    ? EXPENSE_BREAKDOWN_AMOUNT_FIELDS.reduce<ExpenseBreakdownAmounts>(
        (acc, field) => ({ ...acc, [field]: rawBreakdown![field] as number }),
        {} as ExpenseBreakdownAmounts,
      )
    : null
  return {
    monthlyIncomeCents: asCents(store?.approval?.inputs?.monthlyIncomeCents),
    grossMonthlyIncomeCents: asCents(store?.approval?.expenses?.grossMonthlyIncomeCents),
    monthlyExpensesCents: asCents(store?.approval?.inputs?.monthlyExpensesCents),
    breakdown,
  }
}

/**
 * The client's categories as the SNAPSHOT would have recorded them. A client
 * with no breakdown row is not "uncomparable": createAffordabilityExpenseEvidence
 * puts their whole declared total in `other` and zeroes the rest, so that is the
 * shape the approval was decided on. Treating a missing row as uncomparable let
 * a same-total itemisation — the ordinary next step for such a client — reshuffle
 * every category and void the approval unnoticed.
 */
function clientExpenseAmounts(
  breakdown: Partial<ExpenseBreakdownAmounts> | null | undefined,
  monthlyExpensesCents: number,
): ExpenseBreakdownAmounts {
  return EXPENSE_BREAKDOWN_AMOUNT_FIELDS.reduce<ExpenseBreakdownAmounts>(
    (amounts, field) => {
      amounts[field] = breakdown == null
        ? (field === "other" ? monthlyExpensesCents : 0)
        : breakdown[field] ?? 0
      return amounts
    },
    {} as ExpenseBreakdownAmounts,
  )
}

/** Category-by-category equality; a reshuffle at the same total still differs. */
function expenseAmountsMatch(
  actual: ExpenseBreakdownAmounts,
  expected: ExpenseBreakdownAmounts,
): boolean {
  return EXPENSE_BREAKDOWN_AMOUNT_FIELDS.every((field) => actual[field] === expected[field])
}

const EXPENSE_BREAKDOWN_AMOUNT_FIELDS = [
  "housing",
  "transport",
  "food",
  "education",
  "insurance",
  "clothing",
  "entertainment",
  "medical",
  "other",
] as const

type ExpenseBreakdownAmounts = Record<(typeof EXPENSE_BREAKDOWN_AMOUNT_FIELDS)[number], number>
const PRISMA_INT_MAX = 2_147_483_647

function expenseBreakdownMatches(
  existing: (ExpenseBreakdownAmounts & { belowMleJustification: string | null }) | null,
  incoming: ExpenseBreakdownAmounts,
  justification: string | null,
): boolean {
  return existing !== null &&
    EXPENSE_BREAKDOWN_AMOUNT_FIELDS.every((field) => existing[field] === incoming[field]) &&
    (existing.belowMleJustification?.trim() || null) === justification
}

function expenseBreakdownAuditValue(
  value: (ExpenseBreakdownAmounts & {
    id: string
    updatedAt: Date | string
    belowMleJustification: string | null
  }) | null,
) {
  return value
    ? {
        ...value,
        updatedAt: new Date(value.updatedAt).toISOString(),
      }
    : null
}

function nonNegativeCents(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > PRISMA_INT_MAX
  ) {
    throw new ClientFinancialValidationError("Validation failed", {
      [field]: "Must be a non-negative safe integer amount in cents",
    })
  }
  return value
}

function withoutPortalPassword<T extends object>(
  client: T,
): Omit<T, "portalPassword"> {
  const {
    portalPassword: _portalPassword,
    ...safeClient
  } = client as T & { portalPassword?: unknown }
  return safeClient
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("READONLY")
    if (guard.error) return guard.error

    return withTenantContext(req, async (tenant) => {
      const { id } = await ctx.params
      const client = await prisma.client.findUnique({
        where: { id, tenantId: tenant.id },
        include: {
          applications: true,
          loans: true,
          expenseBreakdown: true,
          debtObligations: true,
        },
      })

      if (!client) {
        return NextResponse.json({ error: "Client not found" }, { status: 404 })
      }

      return NextResponse.json(withoutPortalPassword(client))
    })
  } catch (error) {
    console.error("Failed to get client:", error)
    return NextResponse.json(
      { error: "Failed to get client" },
      { status: 500 }
    )
  }
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("CREDIT_OFFICER")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const { id } = await ctx.params
      const data = await req.json()
      const hasKey = (key: string) => Object.prototype.hasOwnProperty.call(data, key)
      const expectedUpdatedAt = typeof data.expectedUpdatedAt === "string"
        ? new Date(data.expectedUpdatedAt)
        : null
      if (!expectedUpdatedAt || Number.isNaN(expectedUpdatedAt.getTime())) {
        return NextResponse.json(
          {
            error: "Validation failed",
            errors: { expectedUpdatedAt: "A valid client revision is required" },
          },
          { status: 400 },
        )
      }

      const breakdownKeyPresent = hasKey("expenseBreakdown")
      if (
        breakdownKeyPresent &&
        (typeof data.expenseBreakdown !== "object" || data.expenseBreakdown === null || Array.isArray(data.expenseBreakdown))
      ) {
        return NextResponse.json(
          { error: "Validation failed", errors: { expenseBreakdown: "Must be an object" } },
          { status: 400 },
        )
      }
      if (hasKey("monthlyExpenses") && !breakdownKeyPresent) {
        return NextResponse.json(
          {
            error: "Validation failed",
            errors: {
              expenseBreakdown: "A complete expense breakdown is required when changing monthly expenses",
            },
          },
          { status: 400 },
        )
      }

      const breakdownHasKey = (key: string) => breakdownKeyPresent &&
        Object.prototype.hasOwnProperty.call(data.expenseBreakdown, key)
      const incomingBreakdownPatch = breakdownKeyPresent
        ? EXPENSE_BREAKDOWN_AMOUNT_FIELDS.reduce<Partial<ExpenseBreakdownAmounts>>(
            (patch, field) => {
              if (breakdownHasKey(field)) {
                patch[field] = nonNegativeCents(
                  data.expenseBreakdown[field],
                  `expenseBreakdown.${field}`,
                )
              }
              return patch
            },
            {},
          )
        : null
      const breakdownJustificationKeyPresent = breakdownHasKey("belowMleJustification")

      const debtsKeyPresent = hasKey("debtObligations")
      if (debtsKeyPresent && !Array.isArray(data.debtObligations)) {
        return NextResponse.json(
          { error: "Validation failed", errors: { debtObligations: "Must be an array" } },
          { status: 400 },
        )
      }
      if (debtsKeyPresent) {
        const malformedDebtIndex = (data.debtObligations as unknown[]).findIndex(
          (debt) => typeof debt !== "object" || debt === null || Array.isArray(debt),
        )
        if (malformedDebtIndex !== -1) {
          return NextResponse.json(
            {
              error: "Validation failed",
              errors: { [`debtObligations.${malformedDebtIndex}`]: "Must be an object" },
            },
            { status: 400 },
          )
        }
      }
      const incomingDebts = debtsKeyPresent
        ? (data.debtObligations as Record<string, unknown>[]).map((debt, index) => ({
            id: typeof debt.id === "string" && debt.id.trim() ? debt.id.trim() : null,
            creditProvider: String(debt.creditProvider ?? "").trim(),
            accountType: String(debt.accountType ?? "").trim(),
            outstandingBalance: nonNegativeCents(
              debt.outstandingBalance,
              `debtObligations.${index}.outstandingBalance`,
            ),
            monthlyInstalment: nonNegativeCents(
              debt.monthlyInstalment,
              `debtObligations.${index}.monthlyInstalment`,
            ),
            notesPresent: Object.prototype.hasOwnProperty.call(debt, "notes"),
            notes: String(debt.notes ?? "").trim() || null,
          }))
        : []
      if (incomingDebts.some((debt) => !debt.creditProvider || !debt.accountType)) {
        return NextResponse.json(
          {
            error: "Validation failed",
            errors: { debtObligations: "Every debt requires a credit provider and account type" },
          },
          { status: 400 },
        )
      }
      let incomingMonthlyDebtTotal = 0
      for (const debt of incomingDebts) {
        if (incomingMonthlyDebtTotal > PRISMA_INT_MAX - debt.monthlyInstalment) {
          throw new ClientFinancialValidationError("Validation failed", {
            debtObligations: "Total monthly debt instalments exceed the supported monetary range",
          })
        }
        incomingMonthlyDebtTotal += debt.monthlyInstalment
      }
      const incomingDebtIds = incomingDebts
        .map((debt) => debt.id)
        .filter((debtId): debtId is string => debtId !== null)
      if (new Set(incomingDebtIds).size !== incomingDebtIds.length) {
        return NextResponse.json(
          { error: "Validation failed", errors: { debtObligations: "Duplicate debt identifiers are not allowed" } },
          { status: 400 },
        )
      }

      // Consent fields must only be touched when the caller actually sent
      // `popiaConsentGiven` — legacy partial updates (e.g. address change)
      // omit it. Previously this PUT unconditionally wrote
      // `popiaConsentGiven: data.popiaConsentGiven || false`, silently
      // revoking the umbrella on every legacy update. Gate BOTH the umbrella
      // write AND the granular `syncClientConsent` call on the same key
      // presence so the two surfaces never drift.
      const consentKeyPresent = hasKey("popiaConsentGiven")
      const consentGranted = consentKeyPresent && data.popiaConsentGiven === true

      const client = await prisma.$transaction(async (tx) => {
        // Coordinate every scalar/breakdown/debt mutation with the final
        // approval/agreement/signing evidence lock. FOR UPDATE prevents those
        // state writes from verifying one profile and committing after this
        // transaction has changed it.
        await lockAffordabilityClientEvidence(tx, {
          tenantId: tenant.id,
          clientId: id,
        })
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "Client"
          WHERE "id" = ${id} AND "tenantId" = ${tenant.id}
          FOR UPDATE
        `)
        if (!locked[0]) throw new ClientUpdateNotFoundError()
        const previous = await tx.client.findUnique({
          where: { id, tenantId: tenant.id },
          select: {
            updatedAt: true,
            idNumber: true,
            firstName: true,
            lastName: true,
            dateOfBirth: true,
            kycStatus: true,
            kycVerifiedAt: true,
            kycVerifiedById: true,
            kycVerificationMethod: true,
            referralCodeId: true,
            grossMonthlyIncome: true,
            monthlyIncome: true,
            monthlyExpenses: true,
            bankName: true,
            bankAccountNumber: true,
            bankBranchCode: true,
            accountType: true,
            expenseBreakdown: {
              select: {
                id: true,
                updatedAt: true,
                housing: true,
                transport: true,
                food: true,
                education: true,
                insurance: true,
                clothing: true,
                entertainment: true,
                medical: true,
                other: true,
                belowMleJustification: true,
              },
            },
            debtObligations: {
              select: {
                id: true,
                creditProvider: true,
                accountType: true,
                outstandingBalance: true,
                monthlyInstalment: true,
                notes: true,
              },
            },
          },
        })
        if (!previous) throw new ClientUpdateNotFoundError()
        if (previous.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
          throw new ClientStaleUpdateError()
        }

        const previousDebtIds = new Set(previous.debtObligations.map((debt) => debt.id))
        if (incomingDebtIds.some((debtId) => !previousDebtIds.has(debtId))) {
          throw new ClientFinancialValidationError("Validation failed", {
            debtObligations: "One or more debts do not belong to this client",
          })
        }

        if (
          incomingBreakdownPatch &&
          previous.expenseBreakdown === null &&
          EXPENSE_BREAKDOWN_AMOUNT_FIELDS.some((field) => !breakdownHasKey(field))
        ) {
          throw new ClientFinancialValidationError("Validation failed", {
            expenseBreakdown:
              "A complete expense breakdown is required when no stored breakdown exists",
          })
        }
        const effectiveExpenseBreakdown = incomingBreakdownPatch
          ? EXPENSE_BREAKDOWN_AMOUNT_FIELDS.reduce<ExpenseBreakdownAmounts>(
              (breakdown, field) => {
                breakdown[field] = incomingBreakdownPatch[field]
                  ?? previous.expenseBreakdown?.[field]
                  ?? 0
                return breakdown
              },
              {} as ExpenseBreakdownAmounts,
            )
          : null
        const computedMonthlyExpensesCents = effectiveExpenseBreakdown
          ? sumExpenseBreakdown(effectiveExpenseBreakdown)
          : null

        const effectiveGrossIncome = hasKey("grossMonthlyIncome")
          ? data.grossMonthlyIncome === null || data.grossMonthlyIncome === ""
            ? null
            : nonNegativeCents(data.grossMonthlyIncome, "grossMonthlyIncome")
          : previous.grossMonthlyIncome
        const effectiveMonthlyIncome = hasKey("monthlyIncome")
          ? nonNegativeCents(data.monthlyIncome, "monthlyIncome")
          : previous.monthlyIncome
        const effectiveMonthlyExpenses = computedMonthlyExpensesCents ?? previous.monthlyExpenses

        // The everyday Edit Client form writes the same income fields the
        // document-extraction route does, so guarding only that route leaves the
        // wider door open: an income overwrite on an APPROVED
        // application breaks the immutable affordability snapshot and the payout
        // cannot be repaired except by a fresh approval — a new PASQ and a
        // new consumer signature.
        //
        // This blocks BREAKING an intact approval, not editing per se. If the
        // record already disagrees with the snapshot the approval is void
        // regardless, and staff must be able to correct the record — that is
        // the only way to recover such a payout. A blanket block on
        // approved clients would make it unrecoverable.
        //
        // Scope is income AND declared expenses — the two the decision
        // fingerprint is computed from with no lighter remedy. The bank tuple
        // and identity fields are decision evidence too, but this route already
        // runs their recovery paths: changing bank details un-verifies the
        // affected statements, changing identity revokes biometric
        // verification. Neither forces a re-approval; a changed income or
        // expense does.
        //
        // EVERY approved application is checked, not one of them. The open-
        // application unique index is scoped per PRODUCT
        // (LoanApplication_one_open_per_client_product_idx), so one client can
        // hold two simultaneously-approved applications with two different
        // snapshots. A findFirst could return the one that has already diverged
        // — void by this rule — and wave through an edit that breaks the other,
        // still-intact one.
        const approvedApplications = await tx.loanApplication.findMany({
          where: { tenantId: tenant.id, clientId: id, status: "APPROVED" },
          select: { id: true, reference: true, affordabilityResult: true },
          orderBy: { id: "asc" },
        })
        for (const approved of approvedApplications) {
          const evidence = approvalDecisionEvidence(approved.affordabilityResult)
          const breaks: string[] = []
          if (
            evidence.monthlyIncomeCents !== null
            && previous.monthlyIncome === evidence.monthlyIncomeCents
            && effectiveMonthlyIncome !== evidence.monthlyIncomeCents
          ) breaks.push("monthlyIncome")
          if (
            evidence.grossMonthlyIncomeCents !== null
            && previous.grossMonthlyIncome === evidence.grossMonthlyIncomeCents
            && effectiveGrossIncome !== evidence.grossMonthlyIncomeCents
          ) breaks.push("grossMonthlyIncome")
          if (
            evidence.monthlyExpensesCents !== null
            && previous.monthlyExpenses === evidence.monthlyExpensesCents
            && effectiveMonthlyExpenses !== evidence.monthlyExpensesCents
          ) breaks.push("monthlyExpenses")
          // The per-category breakdown is hashed too, so a reshuffle that keeps
          // the same total still moves the fingerprint.
          //
          // Only when the request actually carries a breakdown. It is null for
          // every request that does not touch expenses, and reading that null as
          // "no longer matches" refused ordinary edits — a phone number, a bank
          // account — on any client holding an intact approval.
          if (
            evidence.breakdown !== null
            && effectiveExpenseBreakdown !== null
            && expenseAmountsMatch(
              clientExpenseAmounts(previous.expenseBreakdown, previous.monthlyExpenses),
              evidence.breakdown,
            )
            && !expenseAmountsMatch(effectiveExpenseBreakdown, evidence.breakdown)
          ) breaks.push("expenseBreakdown")
          if (breaks.length > 0) {
            throw new ClientApprovalEvidenceError(
              `Cannot change ${breaks.join(" and ")}: application ${approved.reference} is approved and its affordability decision is bound to the current value. Return the application to review, then change it and approve again.`,
            )
          }
        }
        const effectiveBankDetails = {
          bankName: hasKey("bankName") ? String(data.bankName ?? "").trim() || null : previous.bankName,
          bankAccountNumber: hasKey("bankAccountNumber")
            ? String(data.bankAccountNumber ?? "").trim() || null
            : previous.bankAccountNumber,
          bankBranchCode: hasKey("bankBranchCode")
            ? String(data.bankBranchCode ?? "").trim() || null
            : previous.bankBranchCode,
          accountType: hasKey("accountType") ? String(data.accountType ?? "").trim() || null : previous.accountType,
        }
        // PUT wrote whatever arrived straight to a Prisma enum column, unlike
        // POST /api/clients which runs this same allow-list via
        // `validateAllClient`. Prisma rejects a non-enum string, so the gap was
        // not arbitrary input — but it left TRANSMISSION settable by a
        // CREDIT_OFFICER years after it was retired from every picker, and it
        // would silently accept any future enum value the UI is not ready for.
        // The allow-list is derived from ACCOUNT_TYPES, so the server refuses
        // exactly what the dropdown declines to offer.
        // Gated on hasKey: `effectiveBankDetails.accountType` falls back to the
        // STORED value when the request omits the field, so an unscoped check
        // would fail every PUT — a phone-number edit included — for any row
        // holding a value the dropdown no longer offers, with an error naming a
        // field the request never touched. Validate what the caller SENT.
        if (
          hasKey("accountType")
          && effectiveBankDetails.accountType !== null
          && !ACCOUNT_TYPE_VALUES.has(effectiveBankDetails.accountType)
        ) {
          throw new ClientFinancialValidationError("Validation failed", {
            accountType: "Select a valid account type",
          })
        }
        const previousBiometricSubject = {
          id,
          idNumber: previous.idNumber,
          firstName: previous.firstName,
          lastName: previous.lastName,
          dateOfBirth: previous.dateOfBirth,
        }
        const effectiveBiometricSubject = {
          id,
          idNumber: hasKey("idNumber") ? String(data.idNumber ?? "") : previous.idNumber,
          firstName: hasKey("firstName") ? String(data.firstName ?? "") : previous.firstName,
          lastName: hasKey("lastName") ? String(data.lastName ?? "") : previous.lastName,
          dateOfBirth: hasKey("dateOfBirth")
            ? data.dateOfBirth ? new Date(data.dateOfBirth) : null
            : previous.dateOfBirth,
        }
        const bankDetailsChanged =
          effectiveBankDetails.bankName !== previous.bankName ||
          effectiveBankDetails.bankAccountNumber !== previous.bankAccountNumber ||
          effectiveBankDetails.bankBranchCode !== previous.bankBranchCode ||
          effectiveBankDetails.accountType !== previous.accountType
        const financialInputChanged = [
          "grossMonthlyIncome",
          "monthlyIncome",
          "monthlyExpenses",
          "expenseBreakdown",
        ].some(hasKey)
        if (
          hasKey("grossMonthlyIncome") &&
          effectiveGrossIncome === 0 &&
          effectiveMonthlyIncome > 0
        ) {
          throw new ClientFinancialValidationError("Validation failed", {
            grossMonthlyIncome:
              "Gross monthly income must be greater than zero or left blank when net monthly income is declared",
          })
        }
        const effectiveGrossForMle = effectiveGrossIncome !== null && effectiveGrossIncome > 0
          ? effectiveGrossIncome
          : effectiveMonthlyIncome
        const effectiveJustification = breakdownKeyPresent
          ? breakdownJustificationKeyPresent
            ? String(data.expenseBreakdown.belowMleJustification ?? "").trim()
            : previous.expenseBreakdown?.belowMleJustification?.trim() ?? ""
          : previous.expenseBreakdown?.belowMleJustification?.trim() ?? ""
        const normalisedEffectiveJustification = effectiveJustification || null
        const shouldWriteExpenseBreakdown = effectiveExpenseBreakdown !== null &&
          !expenseBreakdownMatches(
            previous.expenseBreakdown,
            effectiveExpenseBreakdown,
            normalisedEffectiveJustification,
          )
        if (financialInputChanged && effectiveGrossForMle > 0) {
          const floor = minimumLivingExpense(effectiveGrossForMle)
          if (effectiveMonthlyExpenses < floor && !effectiveJustification) {
            throw new ClientFinancialValidationError("Validation failed", {
              "expenseBreakdown.belowMleJustification":
                "Justification required when expenses are below the NCA Regulation 23A minimum",
            })
          }
        }

        // Manual referral-agent attribution. Key-presence gated like every
        // other field here: `Client.referralCodeId` drives agent
        // commission on repeat loans (lib/referral-agents/commission.ts), so an
        // omitted key must mean "leave it alone", never "clear it". The
        // whole-row updatedAt lock below already covers the read-modify-write
        // race, so no separate CAS is needed. See lib/clients/referral-update.ts.
        const referralPlan = planReferralUpdate({
          data,
          previousCodeId: previous.referralCodeId,
          actorRole: guard.user.role,
        })
        if (referralPlan.kind === "invalid") {
          throw new ClientFinancialValidationError("Validation failed", {
            referralCodeId: referralPlan.message,
          })
        }
        if (referralPlan.kind === "forbidden") {
          throw new ClientReferralForbiddenError(referralPlan.message)
        }
        if (referralPlan.kind === "change" && referralPlan.codeId) {
          // Never trust the picker: the posted id must be an ACTIVE code owned
          // by an ACTIVE agent in THIS tenant.
          const resolved = await resolveReferralCodeById(tx, {
            tenantId: tenant.id,
            id: referralPlan.codeId,
          })
          if (!resolved) {
            throw new ClientFinancialValidationError("Validation failed", {
              referralCodeId: "That referral code is not active — pick a current agent code",
            })
          }
        }
        // Commission accrues at exactly one moment otherwise — inside the
        // disbursement transaction — so a client whose loans already paid out
        // accrued nothing for the agent now being credited. Planned BEFORE the
        // column moves (the plan needs the outgoing code) and applied AFTER
        // (recordDisbursementCommission reads the column to decide who earns),
        // both inside this transaction: a client pointed at a new agent with no
        // accrual written is the state being removed, not a fallback.
        let retroPlan: RetroPlan | null = null
        // Whether the caller echoed back figures an operator had approved. Fail-
        // open is deliberate — an API caller that never previewed must still
        // work, and the edit form omits them when the preview fetch failed — but
        // an unbound money write has to be auditable rather than invisible.
        let retroBound = false
        if (referralPlan.kind === "change") {
          retroPlan = await loadRetroAttributionPlan(tx, {
            tenantId: tenant.id,
            clientId: id,
            incomingCodeId: referralPlan.codeId,
            previousCodeId: referralPlan.previousCodeId,
            // The values this PUT will LEAVE BEHIND. The self-referral check
            // compares the client against the agent, so a request that renames
            // the client to match the agent AND assigns that agent has to be
            // judged on the new name. Key-presence gated like every other field
            // here: an omitted key must not blank a stored value the check needs.
            subjectOverride: {
              ...(hasKey("firstName") && { firstName: String(data.firstName ?? "") }),
              ...(hasKey("lastName") && { lastName: String(data.lastName ?? "") }),
              ...(hasKey("phone") && { phone: data.phone == null ? null : String(data.phone) }),
              ...(hasKey("email") && { email: data.email == null ? null : String(data.email) }),
            },
          })
          // Refuse the whole operation rather than applying half of it.
          if (retroPlan.blockers.length > 0) {
            throw new ClientReferralBlockedError(describeRetroBlockers(retroPlan.blockers))
          }
          // Bind the write to the figures the operator actually approved. The
          // preview built its own plan; a rate change since then would otherwise
          // write a number nobody signed off on.
          retroBound = hasKey("referralImpact")
          if (retroBound) {
            const mismatch = describeRetroPreviewMismatch(
              retroPlan,
              parseReferralImpactApproval(data.referralImpact),
            )
            if (mismatch) throw new ClientReferralBlockedError(mismatch)
          }
        }
        const referralKeyPresent = referralPlan.kind !== "absent"
        const referralCodeId = referralKeyPresent ? referralPlan.codeId : null
        const clientMutation = await updateClientWithBiometricIdentityRevocation(tx, {
          tenantId: tenant.id,
          clientId: id,
          previous: {
            ...previousBiometricSubject,
            kycStatus: previous.kycStatus,
            kycVerifiedAt: previous.kycVerifiedAt,
            kycVerifiedById: previous.kycVerifiedById,
            kycVerificationMethod: previous.kycVerificationMethod,
          },
          nextSubject: effectiveBiometricSubject,
          where: { id, tenantId: tenant.id, updatedAt: expectedUpdatedAt },
          data: {
            // Although this legacy endpoint is named PUT, callers use it for
            // partial updates (notably banking-only edits before disbursement).
            // Omitted keys must never erase unrelated identity, consent or NCA
            // affordability evidence.
            ...(referralKeyPresent && { referralCodeId: referralCodeId }),
            ...(hasKey("firstName") && { firstName: data.firstName }),
            ...(hasKey("lastName") && { lastName: data.lastName }),
            ...(hasKey("idNumber") && { idNumber: data.idNumber }),
            ...(hasKey("dateOfBirth") && { dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null }),
            ...(hasKey("gender") && { gender: data.gender }),
            ...(hasKey("email") && { email: data.email }),
            ...(hasKey("phone") && { phone: data.phone }),
            ...(hasKey("whatsapp") && { whatsapp: data.whatsapp }),
            ...(hasKey("addressLine1") && { addressLine1: data.addressLine1 }),
            ...(hasKey("suburb") && { suburb: data.suburb }),
            ...(hasKey("city") && { city: data.city }),
            ...(hasKey("province") && { province: data.province }),
            ...(hasKey("postalCode") && { postalCode: data.postalCode }),
            ...(hasKey("employmentStatus") && { employmentStatus: data.employmentStatus }),
            ...(hasKey("employerName") && { employerName: data.employerName }),
            ...(hasKey("employerAddress") && { employerAddress: data.employerAddress }),
            ...(hasKey("grossMonthlyIncome") && {
              grossMonthlyIncome: effectiveGrossIncome,
            }),
            ...(hasKey("monthlyIncome") && {
              monthlyIncome: effectiveMonthlyIncome,
            }),
            ...(computedMonthlyExpensesCents !== null
              ? { monthlyExpenses: computedMonthlyExpensesCents }
              : hasKey("monthlyExpenses")
                ? { monthlyExpenses: effectiveMonthlyExpenses }
                : {}),
            // Staff changed the expenses, to R0 included: a declaration. The
            // form sends every field on every save (a blank as 0), so an
            // unchanged figure says nothing about whether one was declared.
            ...(effectiveMonthlyExpenses !== previous.monthlyExpenses && {
              monthlyExpensesDeclaredAt: new Date(),
            }),
            ...(hasKey("incomeSourceType") && { incomeSourceType: data.incomeSourceType }),
            ...(hasKey("employmentStartDate") && {
              employmentStartDate: data.employmentStartDate ? new Date(data.employmentStartDate) : null,
            }),
            ...(hasKey("salaryPaymentDay") && { salaryPaymentDay: data.salaryPaymentDay }),
            ...(hasKey("bankName") && { bankName: data.bankName }),
            ...(hasKey("bankAccountNumber") && { bankAccountNumber: data.bankAccountNumber }),
            ...(hasKey("bankBranchCode") && { bankBranchCode: data.bankBranchCode }),
            // The VALIDATED value, not the raw one. The allow-list above runs
            // on `effectiveBankDetails.accountType`, which is String()-coerced
            // and trimmed; writing `data.accountType` raw meant " CHEQUE " or
            // ["CHEQUE"] cleared the 400 gate and then threw at Prisma as an
            // invalid enum — a 500 where the caller had earned a 400. Validate
            // and write the same value.
            ...(hasKey("accountType") && {
              accountType:
                effectiveBankDetails.accountType !== null
                && isBankAccountType(effectiveBankDetails.accountType)
                  ? effectiveBankDetails.accountType
                  : null,
            }),
            ...(hasKey("nextOfKinName") && { nextOfKinName: data.nextOfKinName }),
            ...(hasKey("nextOfKinPhone") && { nextOfKinPhone: data.nextOfKinPhone }),
            ...(hasKey("nextOfKinRelationship") && { nextOfKinRelationship: data.nextOfKinRelationship }),
            ...(consentKeyPresent && {
              popiaConsentGiven: consentGranted,
              popiaConsentAt: consentGranted ? new Date() : null,
            }),
          },
          actor: { userId: guard.user.id, userEmail: guard.user.email },
          source: "staff_client_edit",
        })
        let updated = clientMutation.client
        const biometricIdentityRevocation = clientMutation.revocation

        // Now that the column names the incoming agent, the accrual reads the
        // right payee. Writes its own audit rows for both the reversal set and
        // each accrual — a reversal that leaves no trace is the same defect in
        // the other direction.
        let retroOutcome: Awaited<ReturnType<typeof applyRetroAttribution>> | null = null
        if (retroPlan) {
          retroOutcome = await applyRetroAttribution(
            tx,
            {
              tenantId: tenant.id,
              clientId: id,
              plan: retroPlan,
              actor: { userId: guard.user.id, userEmail: guard.user.email },
            },
            recordDisbursementCommission,
          )
        }

        const verifiedBankDocuments = bankDetailsChanged
          ? await tx.clientDocument.findMany({
              where: {
                tenantId: tenant.id,
                clientId: id,
                docType: "BANK_STATEMENT",
                deletedAt: null,
                verified: true,
              },
              select: { id: true },
              orderBy: { id: "asc" },
            })
          : []
        let invalidatedBankDocumentCount = 0

        if (verifiedBankDocuments.length > 0) {
          // A statement verified against the old account is not evidence for
          // the new payout tuple. Invalidate it atomically with the client edit;
          // staff must verify a current statement and rerun AVS before payout.
          const invalidated = await tx.clientDocument.updateMany({
            where: {
              tenantId: tenant.id,
              clientId: id,
              docType: "BANK_STATEMENT",
              deletedAt: null,
              verified: true,
              id: { in: verifiedBankDocuments.map(({ id: documentId }) => documentId) },
            },
            data: {
              verified: false,
              verifiedAt: null,
              verifiedById: null,
              verificationNote: "Bank details changed; verify this document against the current account before disbursement.",
            },
          })
          if (invalidated.count !== verifiedBankDocuments.length) {
            throw new Error("Bank evidence changed concurrently; refresh and try again")
          }
          invalidatedBankDocumentCount = invalidated.count

          // The database rolling-deployment guard may already have projected
          // VERIFIED -> PENDING in the document trigger. Re-read the durable
          // row so this application audit records the actual predecessor,
          // rather than a stale in-memory VERIFIED value.
          const currentClientAfterBankRevocation = await tx.client.findUnique({
            where: { id, tenantId: tenant.id },
          })
          if (!currentClientAfterBankRevocation) throw new ClientUpdateNotFoundError()
          const kycBeforeBankRevocation = clientKycAuditValue(currentClientAfterBankRevocation)
          const compositeKyc = await readCompositeKycState(
            tx as unknown as CompositeKycReader,
            {
              tenantId: tenant.id,
              clientId: id,
              subject: currentClientAfterBankRevocation,
              existing: currentClientAfterBankRevocation,
              preserveVerifiedProvenance: true,
            },
          )
          updated = await tx.client.update({
            where: { id, tenantId: tenant.id },
            data: compositeKyc.state,
          })
          await tx.auditLog.create({
            data: {
              tenantId: tenant.id,
              userId: guard.user.id,
              userEmail: guard.user.email,
              action: AuditAction.KYC_STATUS_CHANGED,
              entity: "Client",
              entityId: id,
              oldValue: kycBeforeBankRevocation,
              newValue: {
                ...clientKycAuditValue(updated),
                reason: "bank_evidence_invalidated",
                invalidatedDocumentIds: verifiedBankDocuments.map(({ id: documentId }) => documentId),
              },
            },
          })
        }

        if (consentKeyPresent) {
          await syncClientConsent(tx, {
            clientId: id,
            popiaConsentGiven: consentGranted,
            capturedBy: guard.user.id,
          })
        }

        if (effectiveExpenseBreakdown && shouldWriteExpenseBreakdown) {
          await tx.clientExpenseBreakdown.upsert({
            where: { clientId: id },
            create: {
              clientId: id,
              ...effectiveExpenseBreakdown,
              belowMleJustification: normalisedEffectiveJustification,
            },
            update: {
              ...effectiveExpenseBreakdown,
              belowMleJustification: normalisedEffectiveJustification,
            },
          })
        }

        if (debtsKeyPresent) {
          await tx.existingDebtObligation.deleteMany({
            where: {
              clientId: id,
              ...(incomingDebtIds.length > 0 ? { id: { notIn: incomingDebtIds } } : {}),
            },
          })
          for (const debt of incomingDebts.filter((entry) => entry.id !== null)) {
            const changed = await tx.existingDebtObligation.updateMany({
              where: { id: debt.id!, clientId: id },
              data: {
                creditProvider: debt.creditProvider,
                accountType: debt.accountType,
                outstandingBalance: debt.outstandingBalance,
                monthlyInstalment: debt.monthlyInstalment,
                ...(debt.notesPresent ? { notes: debt.notes } : {}),
              },
            })
            if (changed.count !== 1) {
              throw new ClientFinancialValidationError("Validation failed", {
                debtObligations: "A debt changed concurrently; refresh and try again",
              })
            }
          }
          const newDebts = incomingDebts.filter((entry) => entry.id === null)
          if (newDebts.length > 0) {
            await tx.existingDebtObligation.createMany({
              data: newDebts.map((debt) => ({
                clientId: id,
                creditProvider: debt.creditProvider,
                accountType: debt.accountType,
                outstandingBalance: debt.outstandingBalance,
                monthlyInstalment: debt.monthlyInstalment,
                notes: debt.notes,
              })),
            })
          }
        }

        const currentDebts = debtsKeyPresent
          ? await tx.existingDebtObligation.findMany({
              where: { clientId: id },
              select: {
                id: true,
                creditProvider: true,
                accountType: true,
                outstandingBalance: true,
                monthlyInstalment: true,
                notes: true,
              },
              orderBy: { id: "asc" },
            })
          : previous.debtObligations

        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            action: AuditAction.CLIENT_UPDATED,
            entity: "Client",
            entityId: id,
            oldValue: {
              ...(referralPlan.kind === "change" && {
                referralCodeId: previous.referralCodeId,
              }),
              grossMonthlyIncome: previous.grossMonthlyIncome,
              monthlyIncome: previous.monthlyIncome,
              monthlyExpenses: previous.monthlyExpenses,
              expenseBreakdown: expenseBreakdownAuditValue(previous.expenseBreakdown),
              debtObligations: previous.debtObligations,
              ...(bankDetailsChanged && {
                bankEvidence: bankEvidenceAuditValue(previous),
              }),
              ...(biometricIdentityRevocation && {
                biometricIdentityEvidence: {
                  subjectFingerprint: biometricIdentityRevocation.previousSubjectFingerprint,
                  clientKyc: clientKycAuditValue(previous),
                },
              }),
            },
            newValue: {
              ...(referralPlan.kind === "change" && {
                referralCodeId: referralCodeId,
              }),
              // What the re-attribution actually did to the commission ledger,
              // the SKIPPED set included. Without it a move that credited
              // nothing because every loan was excluded is indistinguishable
              // from one that had nothing to do.
              ...(retroOutcome && {
                referralRetroAccrual: { ...retroOutcome, bound: retroBound },
              }),
              grossMonthlyIncome: updated.grossMonthlyIncome,
              monthlyIncome: updated.monthlyIncome,
              monthlyExpenses: updated.monthlyExpenses,
              expenseBreakdown: effectiveExpenseBreakdown
                ? {
                    ...effectiveExpenseBreakdown,
                    belowMleJustification: normalisedEffectiveJustification,
                  }
                : expenseBreakdownAuditValue(previous.expenseBreakdown),
              debtObligations: currentDebts,
              ...(bankDetailsChanged && {
                bankEvidence: bankEvidenceAuditValue(updated),
                bankEvidenceRevocation: {
                  reason: "bank_details_changed",
                  invalidatedDocumentIds: verifiedBankDocuments.map(({ id: documentId }) => documentId),
                  invalidatedDocumentCount: invalidatedBankDocumentCount,
                },
              }),
              ...(biometricIdentityRevocation && {
                biometricIdentityEvidence: {
                  subjectFingerprint: biometricIdentityRevocation.currentSubjectFingerprint,
                  clientKyc: clientKycAuditValue(updated),
                  reason: biometricIdentityRevocation.reason,
                  invalidatedDocumentIds: biometricIdentityRevocation.invalidatedDocumentIds,
                  invalidatedDocumentCount: biometricIdentityRevocation.invalidatedDocumentCount,
                },
              }),
            },
          },
        })

        return updated
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        // Explicit because Prisma's 5s default no longer fits: a re-attribution
        // adds ~7 serial round-trips per accruing loan (the accrual's four gate
        // reads, its insert, the verification read, and an audit insert) on top
        // of everything the client edit already does. Ten loans at a pessimistic
        // 20ms leaves almost no headroom under the default.
        //
        // 15s, not more. This transaction holds FOR UPDATE on the client row and
        // the affordability evidence lock, and disbursement, signing and
        // agreement all queue behind those — so a stuck edit has to let go
        // quickly. Better to fail an edit and have staff retry than to block a
        // payout indefinitely.
        timeout: 15_000,
      })

      return NextResponse.json(withoutPortalPassword(client))
    })
  } catch (error) {
    if (error instanceof ClientFinancialValidationError) {
      return NextResponse.json(
        { error: error.message, errors: error.errors },
        { status: 400 },
      )
    }
    if (error instanceof ClientReferralForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: 403 })
    }
    if (error instanceof ClientReferralBlockedError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    if (error instanceof ClientUpdateNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    if (error instanceof ClientStaleUpdateError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    if (error instanceof ClientApprovalEvidenceError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return NextResponse.json(
        { error: "Client financial evidence changed concurrently; refresh and try again." },
        { status: 409 },
      )
    }
    console.error("Failed to update client:", error)
    return NextResponse.json(
      { error: "Failed to update client" },
      { status: 500 }
    )
  }
}

const VALID_KYC_STATUSES = ["PENDING", "VERIFIED", "FAILED", "EXPIRED"] as const
type KycStatusValue = (typeof VALID_KYC_STATUSES)[number]
const VALID_KYC_METHODS = ["PHYSICAL", "DIGITAL", "BIOMETRIC", "SMILE_IDENTITY"] as const
type KycMethodValue = (typeof VALID_KYC_METHODS)[number]
const MIN_MANUAL_KYC_REASON_LENGTH = 10

/**
 * Manual KYC status override (Approve / Reject KYC). The SelfieKycTab buttons
 * previously PATCHed this route, which only had GET+PUT → 405 swallowed
 * silently. This handler sets kycStatus directly, stamps the
 * verification timestamp/method, and writes the audit trail.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("CREDIT_OFFICER")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const { id } = await ctx.params
      const body = (await req.json().catch(() => null)) as
        | {
            kycStatus?: unknown
            kycVerificationMethod?: unknown
            reason?: unknown
            resolveManualRejection?: unknown
            resolutionReason?: unknown
          }
        | null
      if (!body || typeof body !== "object") {
        return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
      }

      const kycStatus = body.kycStatus
      if (
        typeof kycStatus !== "string" ||
        !VALID_KYC_STATUSES.includes(kycStatus as KycStatusValue)
      ) {
        return NextResponse.json(
          { error: `kycStatus must be one of: ${VALID_KYC_STATUSES.join(", ")}` },
          { status: 400 }
        )
      }
      const status = kycStatus as KycStatusValue

      const methodKeyPresent = Object.prototype.hasOwnProperty.call(body, "kycVerificationMethod")
      if (
        methodKeyPresent &&
        (
          typeof body.kycVerificationMethod !== "string" ||
          !VALID_KYC_METHODS.includes(body.kycVerificationMethod as KycMethodValue)
        )
      ) {
        return NextResponse.json(
          { error: `kycVerificationMethod must be one of: ${VALID_KYC_METHODS.join(", ")}` },
          { status: 400 },
        )
      }
      const method = status === "VERIFIED"
        ? methodKeyPresent
          ? (body.kycVerificationMethod as KycMethodValue)
          : "PHYSICAL"
        : null
      const rejectionReason = typeof body.reason === "string" ? body.reason.trim() : ""
      const resolutionRequested = body.resolveManualRejection === true
      const resolutionReason = typeof body.resolutionReason === "string"
        ? body.resolutionReason.trim()
        : ""
      if (status === "FAILED" && rejectionReason.length < MIN_MANUAL_KYC_REASON_LENGTH) {
        return NextResponse.json(
          {
            error: `Manual KYC rejection reason must be at least ${MIN_MANUAL_KYC_REASON_LENGTH} characters.`,
          },
          { status: 400 },
        )
      }
      if (
        resolutionRequested &&
        (
          status === "FAILED" ||
          resolutionReason.length < MIN_MANUAL_KYC_REASON_LENGTH
        )
      ) {
        return NextResponse.json(
          {
            error: `Manual KYC rejection resolution requires a reason of at least ${MIN_MANUAL_KYC_REASON_LENGTH} characters and a non-FAILED target status.`,
          },
          { status: 400 },
        )
      }

      const updated = await prisma.$transaction(async (tx) => {
        // KYC is a live payout precondition. Serialize manual status changes
        // with agreement/signing/disbursement and keep the audit evidence in
        // the same transaction so neither side can commit a stale view.
        await lockAffordabilityClientEvidence(tx, {
          tenantId: tenant.id,
          clientId: id,
        })
        const existing = await tx.client.findUnique({
          where: { id, tenantId: tenant.id },
          select: {
            id: true,
            idNumber: true,
            firstName: true,
            lastName: true,
            dateOfBirth: true,
            kycStatus: true,
            kycVerifiedAt: true,
            kycVerifiedById: true,
            kycVerificationMethod: true,
            kycManualRejectionActive: true,
            kycManualRejectionAt: true,
            kycManualRejectionById: true,
            kycManualRejectionReason: true,
            kycManualRejectionResolvedAt: true,
            kycManualRejectionResolvedById: true,
            kycManualRejectionResolutionReason: true,
          },
        })
        if (!existing) return null

        const resolvingManualRejection =
          existing.kycManualRejectionActive && status !== "FAILED"
        if (resolvingManualRejection && !resolutionRequested) {
          return { manualResolutionRequired: true as const }
        }
        if (!existing.kycManualRejectionActive && resolutionRequested) {
          return { manualResolutionNotActive: true as const }
        }

        const verifiedAt = status === "VERIFIED" ? new Date() : null
        let verifiedState = null
        if (status === "VERIFIED" && verifiedAt && method) {
          const compositeKyc = await readCompositeKycState(
            tx as unknown as CompositeKycReader,
            {
              tenantId: tenant.id,
              clientId: id,
              subject: existing,
              existing: resolvingManualRejection
                ? { ...existing, kycManualRejectionActive: false }
                : existing,
              completion: {
                verifiedAt,
                verifiedById: guard.user.id,
                method,
              },
            },
          )
          if (!compositeKyc.ok) {
            await tx.auditLog.create({
              data: {
                tenantId: tenant.id,
                userId: guard.user.id,
                userEmail: guard.user.email,
                action: AuditAction.KYC_VERIFICATION_BLOCKED,
                entity: "Client",
                entityId: id,
                oldValue: clientKycAuditValue(existing),
                newValue: {
                  attemptedStatus: "VERIFIED",
                  requestedMethod: method,
                  blocked: true,
                  biometricEvidence: compositeKyc.biometricEvidence,
                  missingDocs: compositeKyc.missingCoreDocuments,
                },
              },
            })
            return {
              kycBlocked: true as const,
              biometricEvidence: compositeKyc.biometricEvidence,
              missingDocs: compositeKyc.missingCoreDocuments,
            }
          }
          verifiedState = compositeKyc.state
        }

        const decisionAt = new Date()
        const changed = await tx.client.update({
          where: { id, tenantId: tenant.id },
          data: {
            ...(verifiedState ?? {
              kycStatus: status,
              kycVerifiedAt: null,
              kycVerifiedById: null,
              kycVerificationMethod: null,
            }),
            ...(status === "FAILED" && {
              kycManualRejectionActive: true,
              kycManualRejectionAt: decisionAt,
              kycManualRejectionById: guard.user.id,
              kycManualRejectionReason: rejectionReason,
              kycManualRejectionResolvedAt: null,
              kycManualRejectionResolvedById: null,
              kycManualRejectionResolutionReason: null,
            }),
            ...(resolvingManualRejection && {
              kycManualRejectionActive: false,
              kycManualRejectionResolvedAt: decisionAt,
              kycManualRejectionResolvedById: guard.user.id,
              kycManualRejectionResolutionReason: resolutionReason,
            }),
          },
          select: {
            id: true,
            kycStatus: true,
            kycVerifiedAt: true,
            kycVerifiedById: true,
            kycVerificationMethod: true,
            kycManualRejectionActive: true,
            kycManualRejectionAt: true,
            kycManualRejectionById: true,
            kycManualRejectionReason: true,
            kycManualRejectionResolvedAt: true,
            kycManualRejectionResolvedById: true,
            kycManualRejectionResolutionReason: true,
          },
        })

        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            action: status === "FAILED"
              ? AuditAction.KYC_REJECTED
              : status === "VERIFIED"
                ? AuditAction.KYC_APPROVED
                : AuditAction.KYC_STATUS_CHANGED,
            entity: "Client",
            entityId: id,
            oldValue: clientKycAuditValue(existing),
            // Tag as a manual override so auditors can distinguish this from a
            // document-driven kycStatus rollup (the /documents/[docId]/verify path).
            newValue: {
              ...clientKycAuditValue(changed),
              manualOverride: true,
              manualRejection: status === "FAILED",
              manualRejectionReason: status === "FAILED" ? rejectionReason : null,
              manualRejectionResolved: resolvingManualRejection,
              manualRejectionResolutionReason: resolvingManualRejection
                ? resolutionReason
                : null,
            },
          },
        })
        return changed
      })
      if (!updated) {
        return NextResponse.json({ error: "Client not found" }, { status: 404 })
      }
      if ("kycBlocked" in updated) {
        return NextResponse.json(
          {
            error: "Cannot approve KYC: all four core documents are required, plus one of a current valid biometric attempt, an exact reasoned senior exception (where a selfie was captured and failed), or a recorded in-person verification (where no selfie could be captured). The latter two are ADMIN-only actions.",
            biometricEvidence: updated.biometricEvidence,
            missingDocs: updated.missingDocs,
          },
          { status: 422 },
        )
      }
      if ("manualResolutionRequired" in updated) {
        return NextResponse.json(
          {
            error: "This client has an active manual KYC rejection. Use the explicit resolution action and provide a resolution reason.",
          },
          { status: 409 },
        )
      }
      if ("manualResolutionNotActive" in updated) {
        return NextResponse.json(
          { error: "There is no active manual KYC rejection to resolve." },
          { status: 409 },
        )
      }

      return NextResponse.json(updated)
    })
  } catch (error) {
    console.error("Failed to update client KYC status:", error)
    return NextResponse.json(
      { error: "Failed to update KYC status" },
      { status: 500 }
    )
  }
}

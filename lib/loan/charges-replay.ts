import type { prisma } from "@/lib/prisma"
import { allocateReceipts } from "@/lib/loan/balances"
import { sastCalendarDay } from "@/lib/loan/settlement"
import {
  computeDefaultCharges,
  type DefaultChargeReceipt,
  type DefaultChargeResult,
} from "@/lib/loan/default-charges"
import { bookedServiceFee, letterCharges, type GoLiveInputs } from "@/lib/loan/charges-inputs"
import { computeNonNcaCharges } from "@/lib/asset-finance/non-nca-charges"
import type { ChargePause } from "@/lib/loan/charge-pauses"
import { recoveryChargePauses, recoveryCostCharges } from "@/lib/loan/recovery-pauses"

// Loads one loan's default-charges inputs and runs the pure replay: by
// Loan.ncaRegime, lib/loan/default-charges.ts (NCA) or
// lib/asset-finance/non-nca-charges.ts (NON_NCA). ALL money is CENTS.
// Read-only: persisting the result is lib/loan/charges-sync.ts.
//
// The tenant's charges switch (flag, go-live, one-way stop; charges-switch.ts)
// gates BOTH regimes: while it is off, or after a stop, a NON_NCA loan accrues
// no default interest or collection fee either, and go-live bounds its
// back-charging exactly as for NCA. DECIDED (asset-finance slice 1, §4.11):
// one switch for both regimes, no separate NON_NCA switch. A lender turns
// default charges on once for its whole book; the NON_NCA terms themselves are
// per agreement (nonNcaArrearsTerms below), and null terms mean no charge.

/** Add to a writer's existing loan read so the flag costs no extra query. */
export const CHARGES_FLAG_INCLUDE = {
  select: { config: { select: { defaultChargesEnabled: true, defaultChargesStartedAt: true, defaultChargesStoppedAt: true } } },
} as const

/**
 * Charges are live only once the flag is on AND go-live has been recorded, and
 * never again once they were stopped (--disable is one-way).
 */
export function chargesEnabled(loan: {
  tenant?: {
    config: {
      defaultChargesEnabled: boolean
      defaultChargesStartedAt: Date | null
      defaultChargesStoppedAt?: Date | null
    } | null
  } | null
}): boolean {
  const config = loan.tenant?.config
  return config?.defaultChargesEnabled === true && config.defaultChargesStartedAt != null
    && config.defaultChargesStoppedAt == null
}

const MS_PER_DAY = 86_400_000
/** midday SAST on a SAST calendar day, so it cannot straddle a day boundary */
const sastMidday = (day: number) => new Date(day * MS_PER_DAY + 10 * 3_600_000)
const NEVER = new Date(Date.UTC(9999, 0, 1))

/**
 * First day a loan may be charged, given the tenant's go-live instant. Replays
 * the LEGACY allocation — schedule only, no charges — over receipts valued on
 * or before go-live day:
 *  - nothing overdue at go-live (paid up or current, including settled on
 *    go-live day itself): go-live day, so the loan is never back-charged;
 *  - overdue at go-live: the day after the earliest instalment still overdue,
 *    so only the default still open at go-live is back-charged, never
 *    lateness cured before it.
 */
export function goLiveAccrueFrom(
  schedule: Array<{ dueDate: Date; totalDue: number }>,
  receipts: Array<{ amount: number; receivedAt: Date }>,
  goLive: Date,
): Date {
  const goLiveDay = sastCalendarDay(goLive)
  const rows = [...schedule].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
  const pool = receipts
    .filter((receipt) => sastCalendarDay(receipt.receivedAt) <= goLiveDay)
    .reduce((sum, receipt) => sum + receipt.amount, 0)
  const paid = allocateReceipts(rows, pool)
  const overdueDays = rows
    .filter((row, i) => sastCalendarDay(row.dueDate) < goLiveDay && paid[i] < row.totalDue)
    .map((row) => sastCalendarDay(row.dueDate))
  return sastMidday(overdueDays.length > 0 ? Math.min(...overdueDays) + 1 : goLiveDay)
}

// The tenant-scope-extended client's transaction, as every writer holds it.
export type ChargesTx = Pick<
  Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  "loan" | "payment" | "complianceRecord" | "loanCharge" | "repaymentSchedule" | "auditLog"
>

/** Whether default charges are live for a tenant (flag on AND go-live recorded). */
export async function chargesLiveForTenant(
  db: Pick<typeof prisma, "tenantConfig">,
  tenantId: string,
): Promise<boolean> {
  const config = await db.tenantConfig.findUnique({
    where: { tenantId },
    select: { defaultChargesEnabled: true, defaultChargesStartedAt: true, defaultChargesStoppedAt: true },
  })
  return chargesEnabled({ tenant: { config } })
}

interface NonNcaTerms<D> {
  nonNcaDefaultInterestMargin: D | null
  nonNcaCollectionFeeCents: number | null
}

/**
 * A NON_NCA agreement's arrears terms: the ones ON THE LOAN, never the
 * product's. Booking (lib/asset-finance/booking.ts) copies them from the
 * deal's signed terms, fixed when the agreement was prepared (none = explicit
 * 0), so editing the product never reprices a signed agreement's default
 * interest or fee, and guardAssetDealBooking holds the loan to them. A null
 * term means no charge.
 */
export function nonNcaArrearsTerms<D>(loan: NonNcaTerms<D>): NonNcaTerms<D> {
  return {
    nonNcaDefaultInterestMargin: loan.nonNcaDefaultInterestMargin,
    nonNcaCollectionFeeCents: loan.nonNcaCollectionFeeCents,
  }
}

export interface LoanRef {
  tenantId: string
  loanId: string
}


/**
 * `preview` is for the back-fill DRY RUN only: replaying with the inputs
 * --apply would switch the tenant to (goLiveInputs), whatever its flag says.
 * Nothing that writes may pass it. `decidingStatus` is for the sync, which
 * decides COMPLETED itself and so must not be bounded by a closing date a
 * writer stamped. `pauses` are extra days on which nothing accrues; the
 * loan's recovery charge freeze (lib/loan/recovery-pauses.ts)
 * is always added; every replayAt honours them.
 */
export async function loadChargesReplay(
  tx: ChargesTx,
  ref: LoanRef,
  asOf: Date,
  { preview, decidingStatus = false, pauses }: { preview?: GoLiveInputs; decidingStatus?: boolean; pauses?: ChargePause[] } = {},
) {
  const loan = await tx.loan.findUnique({
    where: { id: ref.loanId, tenantId: ref.tenantId },
    select: {
      principal: true,
      startDate: true,
      commercialCancelledAt: true,
      totalInterest: true, totalRepayable: true, contractualTotalInterest: true, contractualTotalRepayable: true,
      interestRatePm: true,
      ncaRegime: true,
      maturityDate: true,
      status: true,
      closedAt: true,
      writeOffAt: true,
      totalPaid: true,
      outstandingPrincipal: true,
      arrearsAmount: true,
      daysInArrears: true,
      nextPaymentDate: true,
      chargesAccrued: true,
      chargesOutstanding: true,
      defaultChargesExempt: true,
      defaultChargesExemptReason: true,
      defaultChargesExemptEndedAt: true,
      monthlyServiceFee: true,
      nonNcaDefaultInterestMargin: true,
      nonNcaCollectionFeeCents: true,
      product: { select: { code: true, monthlyServiceFee: true } },
      application: { select: { affordabilityResult: true } },
      contractRates: {
        orderBy: { effectiveDate: "asc" },
        select: { effectiveDate: true, resultingRate: true },
      },
      tenant: {
        select: {
          config: {
            select: {
              defaultChargesEnabled: true,
              defaultAdminChargeCents: true,
              defaultAdminPostageCents: true,
              defaultChargesStartedAt: true,
              defaultChargesStoppedAt: true,
            },
          },
        },
      },
      repaymentSchedule: { orderBy: [{ dueDate: "asc" }, { installmentNo: "asc" }] },
      // A recovery's charge freeze (chargesFrozenFrom..chargesFrozenUntil), so that every writer's replay honours it.
      surrenderRequests: {
        where: { chargesFrozenFrom: { not: null }, shortfallCents: { gt: 0 } },
        select: { chargesFrozenFrom: true, chargesFrozenUntil: true },
      },
      recoveries: {
        where: { chargesFrozenFrom: { not: null } },
        select: {
          chargesFrozenFrom: true, chargesFrozenUntil: true,
          costs: { where: { status: "APPROVED", treatment: "CHARGE_TO_ACCOUNT" }, orderBy: { id: "asc" }, select: { id: true, grossCents: true } },
        },
      },
    },
  })
  const allPauses = [...(pauses ?? []), ...(recoveryChargePauses(loan?.recoveries) ?? []), ...(recoveryChargePauses(loan?.surrenderRequests) ?? [])]
  const recoveryCosts = recoveryCostCharges(loan?.recoveries)
  const config = loan?.tenant.config
  // Once charges were stopped nothing is ever derived again, not even a preview.
  if (!loan || !config) return null
  const defaultChargesLive = !config.defaultChargesStoppedAt && (chargesEnabled({ tenant: { config } }) || !!preview)
  if (!defaultChargesLive && loan.ncaRegime !== "NON_NCA") return null

  const receipts = await tx.payment.findMany({
    where: {
      loanId: ref.loanId,
      tenantId: ref.tenantId,
      reversed: false,
      allocationStatus: "ALLOCATED",
    },
    orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      amount: true,
      receivedAt: true,
      defaultInterestAllocated: true,
      chargeFeesAllocated: true,
    },
  })
  // Permanent stop freezes paid charge splits and posting history. Only the
  // remaining schedule cash participates in contractual-interest replay.
  const stoppedHistory = config.defaultChargesStoppedAt && loan.ncaRegime === "NON_NCA"
    ? await tx.loanCharge.findMany({ where: { tenantId: ref.tenantId, loanId: ref.loanId }, orderBy: [{ day: "asc" }, { createdAt: "asc" }], select: { type: true, day: true, amount: true, sourceId: true } })
    : null
  // Only notices the provider confirmed, dated when they were issued — the
  // same predicate the attorney-referral gate and the S129 register use.
  const letters = await tx.complianceRecord.findMany({
    where: {
      tenantId: ref.tenantId,
      type: "SECTION_129_NOTICE",
      referenceId: ref.loanId,
      status: "COMPLETED",
      completedAt: { not: null },
      data: { path: ["lifecycle"], equals: "ISSUED" },
    },
    orderBy: { completedAt: "asc" },
    select: { id: true, completedAt: true, data: true },
  })
  // The amount frozen on each notice; the dry run previews what --apply stamps.
  const adminCharges = letterCharges(letters, preview?.letterCents ?? null)

  // The loan's own agreed fee (booked from the approval snapshot), so editing
  // the product never reprices an existing loan (null: see bookedServiceFee).
  const monthlyServiceFee = loan.monthlyServiceFee ?? bookedServiceFee(loan)
  // Nothing accrues after a write-off or cancellation, nor after a closing
  // unless the caller is itself deciding whether the loan is closed (the sync).
  // A loan pending write-off is still owed and keeps accruing.
  const accrueUntil = loan.status === "WRITTEN_OFF"
    ? loan.writeOffAt ?? undefined
    : loan.status === "CANCELLED" || (loan.status === "COMPLETED" && !decidingStatus)
      ? loan.closedAt ?? undefined
      : undefined
  const goLive = preview?.startedAt ?? config.defaultChargesStartedAt ?? asOf
  // An exempt loan is never charged, so its receipts fall straight to the
  // schedule. After an exemption is lifted, charging resumes from that moment.
  // Recomputed with any probe receipt: a receipt dated before go-live can
  // change whether the loan was overdue at go-live, and pricing it without
  // that understates what the date erases. The dry run previews go-live as
  // now, which is what --apply records.
  const accrueFromWith = (extraReceipts: DefaultChargeReceipt[]) => {
    if (loan.defaultChargesExempt) return NEVER
    const fromGoLive = goLiveAccrueFrom(loan.repaymentSchedule, [...receipts, ...extraReceipts], goLive)
    const ended = loan.defaultChargesExemptEndedAt
    return ended && ended > fromGoLive ? ended : fromGoLive
  }
  const accrueFrom = accrueFromWith([])

  /** Re-run the replay, optionally with a receipt not yet written. */
  const replayAt = (at: Date, extraReceipts: DefaultChargeReceipt[] = []) => {
    const common = {
      schedule: loan.repaymentSchedule,
      receipts: [...receipts, ...extraReceipts],
      interestRatePm: loan.interestRatePm,
      maturityDate: loan.maturityDate,
      asOf: at,
      accrueFrom: extraReceipts.length > 0 ? accrueFromWith(extraReceipts) : accrueFrom,
      accrueUntil,
      pauses: allPauses.length > 0 ? allPauses : undefined,
      recoveryCosts,
    }
    // NON_NCA: the agreement's arrears terms; no NCA caps, letters or service fee.
    if (loan.ncaRegime === "NON_NCA") {
      const terms = nonNcaArrearsTerms(loan)
      const margin = terms.nonNcaDefaultInterestMargin
      const result = computeNonNcaCharges({
        ...common,
        startDate: loan.startDate,
        contractualInterestUntil: loan.commercialCancelledAt ?? undefined,
        defaultInterestMargin: (!defaultChargesLive && !stoppedHistory) || margin === null ? null : margin.toNumber(),
        collectionFeeCents: defaultChargesLive || stoppedHistory ? terms.nonNcaCollectionFeeCents : null,
        stoppedCharges: stoppedHistory ? { at: config.defaultChargesStoppedAt!, receipts } : undefined,
        contractRateHistory: loan.contractRates.map((rate) => ({
          effectiveDate: rate.effectiveDate,
          annualRate: rate.resultingRate.toNumber(),
        })),
      })
      if (!stoppedHistory) return result
      const byId = new Map(receipts.map((receipt) => [receipt.id, receipt]))
      return { ...result,
        postings: stoppedHistory.map((posting) => ({ ...posting, day: posting.day.toISOString().slice(0, 10), sourceId: posting.sourceId ?? undefined })),
        interestAccrued: stoppedHistory.filter((posting) => posting.type === "DEFAULT_INTEREST").reduce((sum, posting) => sum + posting.amount, 0),
        feesAccrued: stoppedHistory.filter((posting) => posting.type !== "DEFAULT_INTEREST").reduce((sum, posting) => sum + posting.amount, 0),
        interestOutstanding: 0, feesOutstanding: 0,
        interestPaid: receipts.reduce((sum, receipt) => sum + receipt.defaultInterestAllocated, 0),
        feesPaid: receipts.reduce((sum, receipt) => sum + receipt.chargeFeesAllocated, 0),
        receiptSplits: result.receiptSplits.map((split) => ({ ...split,
          toDefaultInterest: byId.get(split.receiptId)?.defaultInterestAllocated ?? 0,
          toFees: byId.get(split.receiptId)?.chargeFeesAllocated ?? 0,
        })),
      }
    }
    return computeDefaultCharges({ ...common, adminCharges, monthlyServiceFee })
  }
  return {
    loan,
    receipts,
    defaultChargesLive,
    result: replayAt(asOf),
    replayAt,
    monthlyServiceFee,
    /** set when the fee came from bookedServiceFee; the sync writes it onto the loan */
    unbookedServiceFee: loan.monthlyServiceFee === null ? monthlyServiceFee : null,
    /** null only in a dry-run preview before go-live has been recorded */
    goLive: preview?.startedAt ?? config.defaultChargesStartedAt,
    /** null for an exempt loan, which is never charged */
    accrueFrom: loan.defaultChargesExempt ? null : accrueFrom,
  }
}

export const chargesOutstandingTotal = (result: DefaultChargeResult) =>
  result.interestOutstanding + result.feesOutstanding

/**
 * Default charges owed at `valueDate`, to add to the settlement amount a
 * receipt dated then is bounded by. 0 while the tenant's flag is off.
 *
 * Receipts dated after `valueDate` count as paid on it, so a receipt
 * back-dated before an existing one is bounded conservatively: it can be
 * split to refund-due a little early, never over-collect.
 */
export async function chargesOutstandingAt(
  tx: ChargesTx,
  ref: LoanRef,
  valueDate: Date,
): Promise<number> {
  const replay = await loadChargesReplay(tx, ref, valueDate)
  return replay ? chargesOutstandingTotal(replay.result) : 0
}

export type ChargesReplay = NonNullable<Awaited<ReturnType<typeof loadChargesReplay>>>

/**
 * Default charges a receipt writes off PURELY by its value date: charges
 * accrued with it dated `asOf` minus with it dated `receivedAt`, on a replay
 * already loaded for this transaction. The go-live cut-off is recomputed with
 * the receipt in place, so a receipt dated before go-live is priced for the
 * back-charges it removes. Checked with backdatingInterestRebate against the
 * rebate bound (lib/loan/value-date.ts).
 */
export function chargesBackdating(
  replay: ChargesReplay,
  receipt: { amount: number; receivedAt: Date },
  asOf: Date,
): { rebateCents: number; accruedAtCaptureCents: number } {
  const accrued = (receivedAt: Date) => {
    const result = replay.replayAt(asOf, [{ id: "backdating-probe", amount: receipt.amount, receivedAt }])
    return result.interestAccrued + result.feesAccrued
  }
  const accruedAtCaptureCents = accrued(asOf)
  return {
    rebateCents: Math.max(0, accruedAtCaptureCents - accrued(receipt.receivedAt)),
    accruedAtCaptureCents,
  }
}

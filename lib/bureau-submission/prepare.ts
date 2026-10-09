import type { prisma } from "@/lib/prisma"
import type { ChargesTx } from "@/lib/loan/charges-replay"
import {
  buildLoanInput,
  hasPostPeriodActivity,
  loadAdverseConfirmations,
  loadBureauLoans,
} from "./loan-inputs"
import { mapLoan, type DataFlag, type MappedRecord } from "./map-loan"
import { dayEnd, type Day } from "./period"
import {
  NO_HISTORY,
  dailyCandidateIds,
  loadLedgerHistory,
  monthlyCandidateIds,
  monthlyDisposition,
} from "./population"
import { recordHolds, type HoldReason } from "./validate"

// population -> map -> validate, for one file. READ-ONLY: nothing here writes,
// which is what lets the dry-run script count a book before anything is
// configured or sent.

export type PrepareDb = Pick<typeof prisma, "loan" | "tenantConfig" | "bureauAdverseConfirmation" | "bureauSubmissionRecord"> & ChargesTx

export interface Prepared {
  loanId: string
  dataFlag: DataFlag
  mapped: MappedRecord
  /** empty means the record goes in the file */
  held: HoldReason[]
}

export interface PrepareArgs {
  tenantId: string
  day: Day
  supplierNumber: string
  reportingStartDay: Day
}

/**
 * Two sendable lines with one account number under one data flag would block
 * the whole file. Both are held instead, so staff can see which loans clash.
 */
function holdDuplicateAccounts(prepared: Prepared[]): Prepared[] {
  const key = (p: Prepared) => `${p.dataFlag}|${p.mapped.fields.accountNumber}`
  const counts = new Map<string, number>()
  for (const p of prepared) if (p.held.length === 0) counts.set(key(p), (counts.get(key(p)) ?? 0) + 1)
  return prepared.map((p) => (p.held.length === 0 && (counts.get(key(p)) ?? 0) > 1 ? { ...p, held: ["DUPLICATE_ACCOUNT_NUMBER"] } : p))
}

/**
 * Whether default charges were switched on or off for the tenant after the
 * period. Go-live back-charges loans already in default, and a stop wipes
 * every charge, so either one changes what the helpers compute for an earlier
 * month end. Nothing for that period can be reported after such a switch.
 */
async function chargesSwitchedAfter(db: PrepareDb, tenantId: string, day: Day): Promise<boolean> {
  const config = await db.tenantConfig.findUnique({
    where: { tenantId },
    select: { defaultChargesStartedAt: true, defaultChargesStoppedAt: true },
  })
  const periodEnd = dayEnd(day)
  return [config?.defaultChargesStartedAt, config?.defaultChargesStoppedAt].some((at) => at != null && at >= periodEnd)
}

export async function prepareMonthly(db: PrepareDb, args: PrepareArgs): Promise<Prepared[]> {
  const histories = await loadLedgerHistory(db, args.tenantId)
  const loanIds = await monthlyCandidateIds(db, {
    tenantId: args.tenantId, periodDay: args.day, reportingStartDay: args.reportingStartDay, knownLoanIds: [...histories.keys()],
  })
  const loans = await loadBureauLoans(db, args.tenantId, loanIds)
  const confirmations = await loadAdverseConfirmations(db, args.tenantId, loanIds, args.day)
  const chargesSwitched = await chargesSwitchedAfter(db, args.tenantId, args.day)

  const prepared: Prepared[] = []
  for (const loan of loans) {
    const history = histories.get(loan.id) ?? NO_HISTORY
    const disposition = monthlyDisposition(loan.status, history)
    if (disposition.action === "DROP") continue
    const held: HoldReason[] = disposition.action === "HOLD" ? [disposition.reason] : []
    if (hasPostPeriodActivity(loan, args.day)) held.push("POST_PERIOD_ACTIVITY")
    if (chargesSwitched) held.push("CHARGES_SWITCHED_AFTER_PERIOD")
    const mapped = mapLoan(await buildLoanInput(db, loan, {
      kind: "MONTHLY", dataFlag: "D", day: args.day, supplierNumber: args.supplierNumber,
      confirmedAdverse: confirmations.get(loan.id) ?? [], history,
    }))
    prepared.push({ loanId: loan.id, dataFlag: "D", mapped, held: [...held, ...recordHolds(mapped.fields, "MONTHLY")] })
  }
  return holdDuplicateAccounts(prepared)
}

export async function prepareDaily(db: PrepareDb, args: PrepareArgs): Promise<Prepared[]> {
  const histories = await loadLedgerHistory(db, args.tenantId)
  const candidates = await dailyCandidateIds(db, {
    tenantId: args.tenantId, day: args.day, reportingStartDay: args.reportingStartDay, knownLoanIds: [...histories.keys()],
  })
  const chargesSwitched = await chargesSwitchedAfter(db, args.tenantId, args.day)
  const prepared: Prepared[] = []
  const flags: Array<[DataFlag, string[]]> = [["R", candidates.registrations], ["C", candidates.closures]]
  for (const [dataFlag, loanIds] of flags) {
    for (const loan of await loadBureauLoans(db, args.tenantId, loanIds)) {
      const history = histories.get(loan.id) ?? NO_HISTORY
      const held: HoldReason[] = []
      if (dataFlag === "R") {
        // Already registered by an earlier run of this day.
        if (history.dailyRegistered) continue
        // A late re-run of an old day would register today's balance, not that day's.
        if (hasPostPeriodActivity(loan, args.day)) held.push("POST_PERIOD_ACTIVITY")
        if (chargesSwitched) held.push("CHARGES_SWITCHED_AFTER_PERIOD")
      } else if (history.dailyClosureDays.includes(args.day)) {
        // This closure was already sent by an earlier run of this day.
        continue
      } else if (history.dailySent.length > 0) {
        // A second closure of an account the bureau was already told closed.
        held.push("REOPENED_AFTER_CLOSURE")
      }
      const mapped = mapLoan(await buildLoanInput(db, loan, {
        kind: "DAILY", dataFlag, day: args.day, supplierNumber: args.supplierNumber, confirmedAdverse: [], history,
      }))
      prepared.push({ loanId: loan.id, dataFlag, mapped, held: [...held, ...recordHolds(mapped.fields, "DAILY")] })
    }
  }
  return holdDuplicateAccounts(prepared)
}

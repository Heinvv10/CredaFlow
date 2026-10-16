import type { prisma } from "@/lib/prisma"
import {
  isS125InstalmentLoan,
  restoreContractualBulletSchedule,
  type ContractualRow,
  type SettlementLoanLike,
  type SettlementScheduleRow,
} from "@/lib/loan/settlement"

// The schedule as contracted, before an early settlement re-priced it. A
// payment reversal re-opens a loan on it, and the book as at an earlier date
// is rebuilt on it. A DAILY_ACCRUAL bullet is restored from the loan's
// contractual totals; an instalment loan from the rows the settling receipt's
// audit row recorded (lib/loan/settlement.ts settlementAuditEvidence), which
// the database binds to the PASQ for a PASQ v3 loan (migration
// 20261016200000_s125_instalment_settlement) — so this works for loans booked
// before PASQ v3 too.

export class ContractualScheduleMissingError extends Error {
  constructor(readonly loanId: string) {
    super(`Loan ${loanId} was settled early but its contractual schedule evidence is missing`)
    this.name = "ContractualScheduleMissingError"
  }
}

const isInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

/** The recorded contractual rows, or null if the value is not a well-formed list of them. */
export function readContractualRows(value: unknown): ContractualRow[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const rows: ContractualRow[] = []
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    if (typeof r.id !== "string" || !isInt(r.principalDue) || !isInt(r.interestDue) || !isInt(r.feesDue)
      || !isInt(r.creditLifePremiumDue) || !isInt(r.totalDue)) return null
    if (r.totalDue !== r.principalDue + r.interestDue + r.feesDue) return null
    rows.push({
      id: r.id, installmentNo: isInt(r.installmentNo) ? r.installmentNo : null,
      principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue,
      creditLifePremiumDue: r.creditLifePremiumDue, totalDue: r.totalDue,
    })
  }
  return rows
}

/** An instalment loan whose rows an early settlement re-priced. */
export function isRepricedInstalmentLoan(loan: SettlementLoanLike, schedule: SettlementScheduleRow[]): boolean {
  return isS125InstalmentLoan(loan, schedule)
    && loan.contractualTotalRepayable != null
    && loan.totalRepayable < loan.contractualTotalRepayable
}

/** Pure: the schedule with each recorded row's contractual money put back. */
export function restoreContractualSchedule<T extends SettlementScheduleRow>(args: {
  loan: SettlementLoanLike
  schedule: T[]
  contractualRows: ContractualRow[] | null
}): T[] {
  if (!args.contractualRows) return restoreContractualBulletSchedule(args) as T[]
  const byId = new Map(args.contractualRows.map((row) => [row.id, row]))
  return args.schedule.map((row) => {
    const recorded = byId.get(row.id)
    return recorded
      ? {
          ...row,
          interestDue: recorded.interestDue,
          feesDue: recorded.feesDue,
          creditLifePremiumDue: recorded.creditLifePremiumDue,
          totalDue: recorded.totalDue,
        }
      : { ...row }
  })
}

type AuditDb = Pick<typeof prisma, "auditLog">

/** The contractual rows the latest early instalment settlement of each loan recorded. */
export async function loadContractualRows(db: AuditDb, tenantId: string, loanIds: string[]): Promise<Map<string, ContractualRow[]>> {
  const found = new Map<string, ContractualRow[]>()
  if (loanIds.length === 0) return found
  const audits = await db.auditLog.findMany({
    where: {
      tenantId,
      AND: [
        { newValue: { path: ["earlyInstalmentSettlement"], equals: true } },
        ...(loanIds.length === 1 ? [{ newValue: { path: ["loanId"], equals: loanIds[0] } }] : []),
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { newValue: true },
  })
  const wanted = new Set(loanIds)
  for (const audit of audits) {
    const value = audit.newValue as Record<string, unknown> | null
    const loanId = typeof value?.loanId === "string" ? value.loanId : null
    if (!loanId || !wanted.has(loanId) || found.has(loanId)) continue
    const rows = readContractualRows(value?.contractualRows)
    if (rows) found.set(loanId, rows)
  }
  return found
}

/** One loan's contractual schedule, refusing a re-priced loan whose evidence is missing. */
export async function contractualScheduleOf<T extends SettlementScheduleRow>(
  db: AuditDb,
  loan: SettlementLoanLike & { id: string; tenantId: string },
  schedule: T[],
): Promise<T[]> {
  if (!isRepricedInstalmentLoan(loan, schedule)) {
    return restoreContractualSchedule({ loan, schedule, contractualRows: null })
  }
  const rows = (await loadContractualRows(db, loan.tenantId, [loan.id])).get(loan.id)
  if (!rows) throw new ContractualScheduleMissingError(loan.id)
  return restoreContractualSchedule({ loan, schedule, contractualRows: rows })
}

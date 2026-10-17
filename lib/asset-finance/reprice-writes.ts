// Writes an instalment sale's re-solved pending rows back to its schedule
// (./reprice-loan.ts), in the stored representation of ./schedule-records.ts.
// Returns how much the rows' principal, interest and total moved, which the
// loan's totals move by.
import type { ScheduleStatus } from "@prisma/client"
import { toScheduleRecord } from "./schedule-records"
import type { StoredScheduleRow } from "./stored-schedule"
import type { ScheduleRow } from "./types"
import type { RepriceTx } from "./reprice-loan"

export interface ScheduleChange {
  principal: number
  interest: number
  total: number
}

export async function writeRepricedRows(
  tx: Pick<RepriceTx, "repaymentSchedule">,
  tenantId: string,
  loanId: string,
  stored: StoredScheduleRow[],
  solvedRows: ScheduleRow[],
): Promise<ScheduleChange> {
  const change = { principal: 0, interest: 0, total: 0 }
  for (const row of solvedRows) {
    const before = stored[row.index]
    const capital = toScheduleRecord(row)
    const after = { ...capital, feesDue: before.feesDue, creditLifePremiumDue: before.creditLifePremiumDue,
      totalDue: capital.totalDue + before.feesDue }
    const updated = await tx.repaymentSchedule.updateMany({
      where: { id: before.id, tenantId, loanId, status: before.totalDue === 0 ? before.status as ScheduleStatus : "PENDING", totalPaid: 0 },
      data: {
        principalDue: after.principalDue,
        interestDue: after.interestDue,
        ...(before.commonLawContractualInterestDue == null ? {} : { commonLawContractualInterestDue: after.interestDue }),
        totalDue: after.totalDue,
        assetFinanceOpeningBalanceCents: row.openingBalanceCents,
      },
    })
    if (updated.count !== 1) throw new Error(`reprice: schedule row ${before.installmentNo} of loan ${loanId} changed underneath the repricing`)
    change.principal += after.principalDue - before.principalDue
    change.interest += after.interestDue - before.interestDue
    change.total += after.totalDue - before.totalDue
  }
  return change
}

/** Reallocate a paid period without changing its cash or payment state. */
export async function writeRestatedRows(
  tx: Pick<RepriceTx, "repaymentSchedule">,
  tenantId: string,
  loanId: string,
  stored: StoredScheduleRow[],
  rows: ScheduleRow[],
  lease: boolean,
  contractualInterestByIndex?: Record<number, number>,
): Promise<ScheduleChange> {
  const change = { principal: 0, interest: 0, total: 0 }
  for (const row of rows) {
    const before = stored[row.index]
    const capital = toScheduleRecord(row)
    const data = lease
      ? { assetFinanceOpeningBalanceCents: row.openingBalanceCents }
      : { principalDue: capital.principalDue, interestDue: capital.interestDue, ...(before.commonLawContractualInterestDue == null && contractualInterestByIndex?.[row.index] === capital.interestDue ? {} : { commonLawContractualInterestDue: contractualInterestByIndex?.[row.index] ?? capital.interestDue }), assetFinanceOpeningBalanceCents: row.openingBalanceCents }
    const updated = await tx.repaymentSchedule.updateMany({
      where: { tenantId, loanId, id: before.id, status: before.status as ScheduleStatus, totalPaid: before.totalPaid, totalDue: before.collectibleTotalDue ?? before.totalDue }, data,
    })
    if (updated.count !== 1) throw new Error(`Historical rate restatement lost its locked schedule row ${before.installmentNo}`)
    if (!lease) {
      change.principal += capital.principalDue - before.principalDue
      change.interest += capital.interestDue - before.interestDue
    }
  }
  return change
}

// Writes an instalment sale's re-solved pending rows back to its schedule
// (./reprice-loan.ts), in the stored representation of ./schedule-records.ts.
// Returns how much the rows' principal, interest and total moved, which the
// loan's totals move by.
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
    const after = toScheduleRecord(row)
    const updated = await tx.repaymentSchedule.updateMany({
      where: { id: before.id, tenantId, loanId, status: "PENDING", totalPaid: 0 },
      data: {
        principalDue: after.principalDue,
        interestDue: after.interestDue,
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

import { describe, expect, it } from 'vitest'
import { leaseCapitalRows } from './lease-reprice'
import { restateSettledSchedule } from './reprice-restatement'
import type { StoredScheduleRow } from './stored-schedule'

describe('independent lease late-rate capital boundary', () => {
 it('OBSERVED BUG: carried gross collectibleTotalDue contaminates ex-VAT funding restatement', async () => {
  const stored: StoredScheduleRow[] = [
   { id: 'one', installmentNo: 1, dueDate: new Date('2026-02-01T00:00:00+02:00'), principalDue: 13800, interestDue: 0, feesDue: 0, creditLifePremiumDue: 0, totalDue: 13800, collectibleTotalDue: 13800, totalPaid: 13800, status: 'PAID', assetFinanceOpeningBalanceCents: 100000 },
   { id: 'two', installmentNo: 2, dueDate: new Date('2026-03-01T00:00:00+02:00'), principalDue: 13800, interestDue: 0, feesDue: 0, creditLifePremiumDue: 0, totalDue: 13800, collectibleTotalDue: 13800, totalPaid: 0, status: 'PENDING', assetFinanceOpeningBalanceCents: 90849 },
  ]
  const tx = {
   assetFinanceDeal: { findFirst: async () => ({ balloonCents: 80000, rentalTiming: 'ARREARS' }) },
   leaseRental: { findMany: async () => stored.map((row,i) => ({ id: `r${i}`, periodNo: i+1, scheduleId: row.id, rentalExclVatCents: 10000, maintenanceExclVatCents: 2000, vatRate: .15, taxInvoiceId: null })) },
  }
  const view = await leaseCapitalRows(tx as never, 'tenant', 'loan', stored)
  if ('error' in view) throw Error(view.error)
  expect(view.rows[0].totalDue).toBe(10000)
  const input = { paidThroughIndex: 0, originalClosingBalanceCents: 90849, startDate: '2026-01-01', oldPath: [{ effectiveDate: '2026-01-01', annualRate: .1 }], newPath: [{ effectiveDate: '2026-01-01', annualRate: .2 }], effectiveDate: '2026-01-01' }
  const result = restateSettledSchedule({ ...input, stored: view.rows })
  const correct = restateSettledSchedule({ ...input, stored: view.rows.map(row => ({ ...row, collectibleTotalDue: row.totalDue })) })
  expect(correct.rows[0].totalCents).toBe(10000)
  expect(result.rows[0].totalCents).toBe(13800)
  expect(correct.closingBalanceCents - result.closingBalanceCents).toBe(3800)
 })
})

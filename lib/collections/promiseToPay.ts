/**
 * Promise-to-Pay tracking — compares promises to actual payments.
 *
 * ⚠️ NO PRODUCTION CALLERS as at 2026-07-31. The promise status staff actually
 * see is rendered by `PromiseToPayTab` in
 * `components/collections/CollectionDetailTabs.tsx`, which does its own
 * filtering over already-loaded payments. Changing THIS file changes nothing a
 * user sees, and its test file proves only that this function works — not that
 * the screen does. Fix the component too, or instead.
 *
 * The rule both share lives in `./promise-window.ts` so they cannot drift
 * again; they previously disagreed on zero-amount promises.
 */

import { prisma } from "@/lib/prisma"
import { CASH_RECEIPTS } from "@/lib/payments/waiver"
import { isPromiseKept, promiseWindow } from "@/lib/collections/promise-window"

interface PromiseStatus {
  noteId: string
  promiseDate: string
  promiseAmount: number
  kept: boolean
  paymentReceived: number
  createdAt: Date
}

export async function getPromiseToPayStatus(loanId: string, tenantId: string): Promise<PromiseStatus[]> {
  const notes = await prisma.loanNote.findMany({
    where: { tenantId, loanId, type: "promise_to_pay" },
    orderBy: { createdAt: "desc" },
  })

  const results: PromiseStatus[] = []

  for (const note of notes) {
    let promiseAmount = 0
    let promiseDate = ""

    try {
      const parsed = JSON.parse(note.note)
      promiseAmount = parsed.promiseAmount ?? 0
      promiseDate = parsed.promiseDate ?? ""
    } catch {
      // Legacy format — skip parsing
      continue
    }

    if (!promiseDate) continue

    const { start: lookbackStart, end: lookForwardEnd } = promiseWindow({
      noteCreatedAt: new Date(note.createdAt),
      promiseDate: new Date(promiseDate),
    })

    const payments = await prisma.payment.findMany({
      where: {
        tenantId,
        loanId,
        // The date the money arrived, not the date staff captured it. A promise
        // honoured on the day but captured after the 3-day grace would
        // otherwise read as broken.
        receivedAt: { gte: lookbackStart, lte: lookForwardEnd },
        reversed: false,
        allocationStatus: "ALLOCATED",
        // A waived balance does not keep a promise to pay.
        ...CASH_RECEIPTS,
      },
      select: { amount: true },
    })

    const totalReceived = payments.reduce((sum, p) => sum + p.amount, 0)
    const kept = isPromiseKept({ promiseAmount, totalReceived })

    results.push({
      noteId: note.id,
      promiseDate,
      promiseAmount,
      kept,
      paymentReceived: totalReceived,
      createdAt: note.createdAt,
    })
  }

  return results
}

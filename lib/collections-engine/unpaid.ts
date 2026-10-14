/**
 * The LoanNote an unpaid or disputed collection leaves on the loan, written in
 * the same transaction as the result it describes, so the two cannot diverge.
 *
 * Arrears and DPD come from the schedule, which an unpaid debit does not
 * change; the existing reminder and escalation crons act on them. The
 * collections stage stays staff-advanced (lib/collections/.claude.md): the
 * engine never moves it and sends no borrower message itself.
 */
import { formatZAR } from "@/lib/utils"
import type { EngineTx } from "./context"

export const UNPAID_NOTE_TYPE = "debit_order_unpaid"
/** A return or dispute reported for a debit already booked as paid. */
export const REVIEW_NOTE_TYPE = "debit_order_review"

export async function noteCollectionOutcome(tx: EngineTx, args: {
  tenantId: string
  loanId: string
  instalmentNo: number
  presentmentNo: number
  amountCents: number
  outcome: "UNPAID" | "DISPUTED"
  reasonCode: string | null
  afterPayment: boolean
}): Promise<void> {
  const what = args.outcome === "DISPUTED" ? "was disputed by the debtor" : `came back unpaid (${args.reasonCode ?? "no reason given"})`
  const debit = `Debit order of ${formatZAR(args.amountCents)} for instalment ${args.instalmentNo} (presentment ${args.presentmentNo})`
  await tx.loanNote.create({
    data: {
      tenantId: args.tenantId,
      loanId: args.loanId,
      type: args.afterPayment ? REVIEW_NOTE_TYPE : UNPAID_NOTE_TYPE,
      note: args.afterPayment
        ? `${debit}, already booked as paid, ${what} afterwards. The receipt stands until staff review it.`
        : `${debit} ${what}.`,
      createdBy: "system",
    },
  })
}

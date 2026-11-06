import { triggerNotification } from "@/lib/notifications"
import { logger } from "@/lib/observability/logger"

/**
 * The borrower's payment_received message for a booked M-Pesa receipt, sent
 * after the booking committed and only when the money was allocated: a
 * refund-due or held receipt has not updated the balance the message shows
 * (as app/api/portal/payment/webhook/settle-receipt.ts). Never blocks the booking.
 */
export function notifyReceiptBooked(args: {
  tenantId: string
  loanId: string
  payment: { id: string; amount: number; allocationStatus: string }
}): void {
  if (args.payment.allocationStatus !== "ALLOCATED") return
  triggerNotification({
    tenantId: args.tenantId,
    event: "payment_received",
    loanId: args.loanId,
    data: { amount: args.payment.amount, paymentId: args.payment.id },
  }).catch((error: unknown) => {
    logger.error("[mobile-money] payment_received notification failed", {
      paymentId: args.payment.id, error: error instanceof Error ? error.message : String(error),
    })
  })
}

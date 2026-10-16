import { defineAuditActions } from "../define"

export default defineAuditActions({
  // A borrower reported a payment from the portal (lib/payments/payment-notifications.ts)
  PAYMENT_NOTIFICATION_RECEIVED: "PAYMENT_NOTIFICATION_RECEIVED",
  // Staff captured the reported payment as a receipt
  PAYMENT_NOTIFICATION_ALLOCATED: "PAYMENT_NOTIFICATION_ALLOCATED",
  // Staff found no such payment and rejected the report, with a reason
  PAYMENT_NOTIFICATION_REJECTED: "PAYMENT_NOTIFICATION_REJECTED",
})

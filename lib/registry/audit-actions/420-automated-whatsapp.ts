import { defineAuditActions } from "../define"

export default defineAuditActions({
  // The lender's automated WhatsApp reminders switch (lib/automation/whatsapp-switch.ts).
  AUTOMATED_WHATSAPP_REMINDERS_UPDATED: "AUTOMATED_WHATSAPP_REMINDERS_UPDATED",
})

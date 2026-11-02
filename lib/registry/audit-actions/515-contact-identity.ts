import { defineAuditActions } from "../define"

export default defineAuditActions({
  // A staff-set email or WhatsApp number confirmed by someone else, so a signing code may go to it (lib/contact/identity-confirmation.ts).
  CONTACT_IDENTITY_CONFIRMED: "CONTACT_IDENTITY_CONFIRMED",
})

/**
 * Per-callsite cutover flags for the Phase 9 S2 sendMessage() migration.
 *
 * Each function returns true ONLY when the flag is the literal string
 * "true" — strict match avoids accidentally enabling the new path via
 * `"TRUE"` or `"1"` typos that some operators reflexively type.
 */
export function isPortalForgotNewSendEnabled(): boolean {
  return process.env.MESSAGING_NEW_SEND_PORTAL_FORGOT === "true"
}

/**
 * Portal ACTIVATION code (app/api/portal/register). Distinct from
 * MESSAGING_NEW_SEND_PORTAL_FORGOT, which governs the password-RESET code —
 * different routes, different templates, so they cut over independently.
 */
export function isPortalActivationNewSendEnabled(): boolean {
  return process.env.MESSAGING_NEW_SEND_PORTAL_ACTIVATION === "true"
}

/** Delivery of the countersigned credit agreement (NCA s.93(1)). */
export function isAgreementDeliveryNewSendEnabled(): boolean {
  return process.env.MESSAGING_NEW_SEND_AGREEMENT_DELIVERY === "true"
}

/**
 * PASQ acknowledgement link (NCA s.92(1)). One flag for all three channels —
 * the consultant picks the channel per send, so cutting one over without the
 * others would put half the sends on the timeline and half nowhere.
 */
export function isPasqLinkNewSendEnabled(): boolean {
  return process.env.MESSAGING_NEW_SEND_PASQ_LINK === "true"
}

export function isSection129NewSendEnabled(): boolean {
  return process.env.MESSAGING_NEW_SEND_S129 === "true"
}

export function isCollectionsNewSendEnabled(): boolean {
  return process.env.MESSAGING_NEW_SEND_COLLECTIONS === "true"
}

export function isAppSubmittedNewSendEnabled(): boolean {
  return process.env.MESSAGING_NEW_SEND_NOTIF_APP_SUBMITTED === "true"
}

export function isAppDeclinedNewSendEnabled(): boolean {
  return process.env.MESSAGING_NEW_SEND_NOTIF_APP_DECLINED === "true"
}

export function isLoanApprovedNewSendEnabled(): boolean {
  return process.env.MESSAGING_NEW_SEND_NOTIF_LOAN_APPROVED === "true"
}

export function isLoanDisbursedNewSendEnabled(): boolean {
  return process.env.MESSAGING_NEW_SEND_NOTIF_LOAN_DISBURSED === "true"
}

export function isLoanOverdueNewSendEnabled(): boolean {
  return process.env.MESSAGING_NEW_SEND_NOTIF_LOAN_OVERDUE === "true"
}

export function isPaymentReceivedNewSendEnabled(): boolean {
  return process.env.MESSAGING_NEW_SEND_NOTIF_PAYMENT_RECEIVED === "true"
}

/**
 * The payment-reminders cron's WhatsApp leg. Distinct from
 * MESSAGING_NEW_SEND_COLLECTIONS, which governs the OTHER reminder cron
 * (lib/collections/reminders.ts) — the two fire on different days and hold
 * different templates, so they cut over independently.
 */
export function isPaymentRemindersNewSendEnabled(): boolean {
  return process.env.MESSAGING_NEW_SEND_PAYMENT_REMINDERS === "true"
}

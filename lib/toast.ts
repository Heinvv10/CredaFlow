/**
 * LMS — Toast helpers
 * Single source of truth for all user-facing feedback messages.
 * Import { toast } from "@/lib/toast" everywhere — never import sonner directly.
 */

import { toast as sonner } from "sonner"

export const toast = {
  // ── Generic ──────────────────────────────────────────────────────────────
  success: (message: string, description?: string) =>
    sonner.success(message, { description }),

  error: (message: string, description?: string) =>
    sonner.error(message, { description }),

  warning: (message: string, description?: string) =>
    sonner.warning(message, { description }),

  info: (message: string, description?: string) =>
    sonner.info(message, { description }),

  loading: (message: string) =>
    sonner.loading(message),

  promise: <T>(
    promise: Promise<T>,
    messages: { loading: string; success: string; error: string }
  ) => sonner.promise(promise, messages),

  dismiss: (id?: string | number) => sonner.dismiss(id),

  // ── Client ───────────────────────────────────────────────────────────────
  client: {
    created: () => sonner.success("Client created", { description: "The client profile has been saved." }),
    updated: () => sonner.success("Client updated", { description: "Changes have been saved successfully." }),
    deleted: () => sonner.success("Client removed"),
  },

  // ── Application ──────────────────────────────────────────────────────────
  application: {
    created: () => sonner.success("Application created", { description: "The loan application has been saved." }),
    submitted: () => sonner.success("Application submitted", { description: "The application is now under review." }),
    approved: () => sonner.success("Application approved ✓", { description: "The loan has been approved and is ready to disburse." }),
    declined: () => sonner.error("Application declined", { description: "The application has been declined." }),
    savedDraft: () => sonner.info("Draft saved", { description: "Application saved as draft." }),
    mismatchBlock: () => sonner.error("Cannot submit", { description: "Resolve document mismatches before submitting for review." }),
  },

  // ── Documents ────────────────────────────────────────────────────────────
  document: {
    uploaded: (docType: string) => sonner.success(`${docType} uploaded`, { description: "Document is being scanned and verified." }),
    deleted: () => sonner.success("Document deleted", { description: "The file has been permanently removed." }),
    verified: () => sonner.success("Document verified ✓"),
    mismatch: () => sonner.error("Document mismatch detected", { description: "The document does not match the client record." }),
    extractionDone: () => sonner.success("Document scanned", { description: "Data has been extracted and verified." }),
    extractionFailed: () => sonner.warning("Scan incomplete", { description: "Automatic extraction failed. Manual review required." }),
    noId: () => sonner.warning("ID required first", { description: "Please upload and process an ID document before taking a selfie." }),
  },

  // ── KYC / Selfie ─────────────────────────────────────────────────────────
  kyc: {
    verified: (score: number) => sonner.success(`Identity verified (${score}% match) ✓`, { description: "Biometric verification passed via Smile Identity." }),
    failed: (score: number) => sonner.error(`Identity verification failed (${score}% match)`, { description: "The selfie does not match the ID document." }),
    processing: () => sonner.loading("Verifying identity…"),
  },

  // ── Payments ─────────────────────────────────────────────────────────────
  payment: {
    recorded: (amount: string) => sonner.success(`Payment of ${amount} recorded`, { description: "The repayment schedule has been updated." }),
    recordedFullyUnapplied: (amount: string) => sonner.success(
      `Payment of ${amount} recorded`,
      { description: "Nothing was owed on this loan, so the full amount is held unapplied and must be refunded or reconciled." },
    ),
    recordedWithRefund: (amount: string, refund: string) => sonner.success(
      `Payment of ${amount} recorded`,
      { description: `Loan settled. ${refund} is held as a refund due to the client — reconcile it once paid back.` },
    ),
    failed: () => sonner.error("Payment failed", { description: "Could not record the payment. Please try again." }),
  },

  // ── Disbursement ─────────────────────────────────────────────────────────
  disbursement: {
    success: (ref: string) => sonner.success(`Loan ${ref} disbursed ✓`, { description: "The loan account is now active." }),
    failed: () => sonner.error("Disbursement failed", { description: "Could not process the disbursement." }),
  },

  // ── Section 129 ──────────────────────────────────────────────────────────
  section129: {
    sent: () => sonner.success("Section 129 dispatch accepted", { description: "The email provider accepted the notice. This does not confirm delivery." }),
    simulated: () => sonner.success("Section 129 notice simulated", { description: "Demo mailbox: recorded as simulated (not sent)." }),
    failed: (reason?: string) => sonner.error("Section 129 notice not sent", { description: reason ?? "Could not send the Section 129 notice." }),
  },

  // ── Agreement ───────────────────────────────────────────────────────────
  agreement: {
    generated: () => sonner.success("Agreement generated", { description: "Credit agreement PDF is ready for signature." }),
    signed: () => sonner.success("Agreement signed \u2713", { description: "The credit agreement has been recorded as signed." }),
    signFailed: () => sonner.error("Could not record signature"),
    disbursementBlocked: () => sonner.error("Signature required", { description: "Sign the credit agreement before disbursing." }),
  },

  // ── Settings ─────────────────────────────────────────────────────────────
  settings: {
    saved: () => sonner.success("Settings saved"),
    testSuccess: (provider: string) => sonner.success(`${provider} connected ✓`, { description: "Test request successful." }),
    testFailed: (provider: string, error?: string) => sonner.error(`${provider} test failed`, { description: error ?? "Check your credentials and try again." }),
  },

  // ── Generic CRUD ─────────────────────────────────────────────────────────
  saved: () => sonner.success("Saved"),
  deleted: () => sonner.success("Deleted"),
  copied: () => sonner.success("Copied to clipboard"),
  networkError: () => sonner.error("Network error", { description: "Check your connection and try again." }),
  unauthorized: () => sonner.error("Unauthorized", { description: "You do not have permission to perform this action." }),
}

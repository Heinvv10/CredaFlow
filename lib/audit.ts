/**
 * Audit log helper — records all key platform actions to AuditLog table
 */

import { prisma } from "@/lib/prisma"
import { Prisma } from "@prisma/client"

interface AuditParams {
  tenantId?: string
  userId?: string
  userEmail?: string
  action: string
  entity: string
  entityId?: string
  oldValue?: Record<string, unknown> | null
  newValue?: Record<string, unknown> | null
  ipAddress?: string
}

export async function logAudit(params: AuditParams): Promise<void> {
  try {
    await logAuditStrict(params)
  } catch (error) {
    // Audit log failures must never break the main operation — but they must
    // not be invisible either. Callers rely on this row as the ONLY record of
    // money-moving changes (e.g. a referral commission reassignment in
    // app/api/clients/[id]/route.ts), and a silent no-op means that record is
    // simply gone with nothing to alert on.
    console.error(
      "Failed to write audit log:",
      { action: params.action, entity: params.entity, entityId: params.entityId },
      error,
    )
  }
}

/**
 * Use only where the audited operation must fail closed if evidence cannot be written.
 * Pass the transaction client to commit the row with the change it records.
 */
export async function logAuditStrict(params: AuditParams, db: Pick<typeof prisma, "auditLog"> = prisma): Promise<void> {
  await db.auditLog.create({
    data: {
      tenantId: params.tenantId,
      userId: params.userId ?? null,
      userEmail: params.userEmail ?? null,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId ?? null,
      oldValue: (params.oldValue ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      newValue: (params.newValue ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      ipAddress: params.ipAddress ?? null,
    },
  })
}

// Convenience actions
export const AuditAction = {
  // Loan lifecycle
  LOAN_APPROVED: "LOAN_APPROVED",
  LOAN_DECLINED: "LOAN_DECLINED",
  LOAN_CREATED: "LOAN_CREATED",
  LOAN_DISBURSED: "LOAN_DISBURSED",
  LOAN_DISBURSEMENT_REFUSED: "LOAN_DISBURSEMENT_REFUSED",
  LOAN_CANCELLED: "LOAN_CANCELLED",
  LOAN_STATUS_CHANGED: "LOAN_STATUS_CHANGED",
  LOAN_BUREAU_OVERRIDE: "LOAN_BUREAU_OVERRIDE",
  // Asset finance rates (lib/asset-finance/reprice-loan.ts,
  // app/api/asset-finance/reference-rates): a reference value recorded
  // (PENDING), approved or rejected by a second person, a recording or decision
  // refused (no authority, or the four-eyes rule), and a linked loan's pending
  // schedule re-solved on an approved value.
  REFERENCE_RATE_RECORDED: "REFERENCE_RATE_RECORDED",
  REFERENCE_RATE_DECIDED: "REFERENCE_RATE_DECIDED",
  REFERENCE_RATE_REFUSED: "REFERENCE_RATE_REFUSED",
  LOAN_REPRICED: "LOAN_REPRICED",
  LOAN_REPRICE_REFUSED: "LOAN_REPRICE_REFUSED",
  // Credit checks (lib/credit-checks): flags raised/superseded by a recompute,
  // and an officer clearing one with a reason.
  CREDIT_CHECKS_RECOMPUTED: "CREDIT_CHECKS_RECOMPUTED",
  CREDIT_CHECK_FLAG_CLEARED: "CREDIT_CHECK_FLAG_CLEARED",
  // A credit officer downloaded an application's read statements as a workbook
  // (app/api/applications/[id]/statement-export); each statement is also in DocumentAccessLog.
  STATEMENT_EXPORTED: "STATEMENT_EXPORTED",
  STATEMENT_READ_RETRIED: "STATEMENT_READ_RETRIED",
  PRODUCT_PRICING_UPDATED: "PRODUCT_PRICING_UPDATED",

  // Agreement
  AGREEMENT_GENERATED: "AGREEMENT_GENERATED",
  AGREEMENT_SIGNED: "AGREEMENT_SIGNED",
  AGREEMENT_PROVIDER_COUNTERSIGNED: "AGREEMENT_PROVIDER_COUNTERSIGNED",
  AGREEMENT_INTEGRITY_BACKFILLED: "AGREEMENT_INTEGRITY_BACKFILLED",
  AGREEMENT_ARTIFACT_STAGED: "AGREEMENT_ARTIFACT_STAGED",
  AGREEMENT_ARTIFACT_STAGING_RECOVERY_STARTED: "AGREEMENT_ARTIFACT_STAGING_RECOVERY_STARTED",
  AGREEMENT_ARTIFACT_STAGING_FAILED: "AGREEMENT_ARTIFACT_STAGING_FAILED",
  AGREEMENT_EMAILED_TO_CLIENT: "AGREEMENT_EMAILED_TO_CLIENT",
  AGREEMENT_EMAIL_FAILED: "AGREEMENT_EMAIL_FAILED",
  SIGNING_PACKET_EMAILED: "SIGNING_PACKET_EMAILED",
  SIGNING_PACKET_EMAIL_FAILED: "SIGNING_PACKET_EMAIL_FAILED",
  SIGNED_PACKET_UPLOADED: "SIGNED_PACKET_UPLOADED",
  SIGNED_PACKET_RECORDED: "SIGNED_PACKET_RECORDED",
  INITIATION_FEE_ELECTION_RECORDED: "INITIATION_FEE_ELECTION_RECORDED",
  PASQ_ARTIFACT_STAGED: "PASQ_ARTIFACT_STAGED",
  PASQ_ARTIFACT_STAGING_RECOVERY_STARTED: "PASQ_ARTIFACT_STAGING_RECOVERY_STARTED",
  PASQ_ARTIFACT_STAGING_FAILED: "PASQ_ARTIFACT_STAGING_FAILED",
  PASQ_GENERATED: "PASQ_GENERATED",
  PASQ_ACKNOWLEDGED: "PASQ_ACKNOWLEDGED",
  PASQ_LINK_SENT: "PASQ_LINK_SENT",
  PASQ_LINK_SEND_FAILED: "PASQ_LINK_SEND_FAILED",
  DEBIT_MANDATE_PREPARED: "DEBIT_MANDATE_PREPARED",
  DEBIT_MANDATE_SIGNED: "DEBIT_MANDATE_SIGNED",
  DEBIT_MANDATE_ARTIFACT_STAGED: "DEBIT_MANDATE_ARTIFACT_STAGED",
  DEBIT_MANDATE_ARTIFACT_STAGING_RECOVERY_STARTED: "DEBIT_MANDATE_ARTIFACT_STAGING_RECOVERY_STARTED",
  DEBIT_MANDATE_ARTIFACT_STAGING_FAILED: "DEBIT_MANDATE_ARTIFACT_STAGING_FAILED",

  // Payments
  PAYMENT_RECORDED: "PAYMENT_RECORDED",
  PAYMENT_REVERSED: "PAYMENT_REVERSED",
  PAYMENT_ALLOCATED: "PAYMENT_ALLOCATED",
  PAYMENT_LEDGER_RECONCILED: "PAYMENT_LEDGER_RECONCILED",
  PAYMENT_REFUND_RECORDED: "PAYMENT_REFUND_RECORDED",
  // Part of a receipt nothing on the loan can absorb, split off as refund-due (lib/loan/refund-excess.ts)
  PAYMENT_REFUND_DUE_SPLIT: "PAYMENT_REFUND_DUE_SPLIT",
  // Waived cents no longer needed once charges are removed; a waiver is never refunded
  PAYMENT_WAIVER_RETIRED: "PAYMENT_WAIVER_RETIRED",
  // Default interest / post-default charges re-derived (lib/loan/charges-sync.ts)
  LOAN_CHARGES_SYNCED: "LOAN_CHARGES_SYNCED",
  // Schedule paidAt left as it was: the receipts do not describe the schedule (lib/loan/schedule-paid-at.ts)
  SCHEDULE_PAIDAT_RESTAMP_SKIPPED: "SCHEDULE_PAIDAT_RESTAMP_SKIPPED",
  LOAN_SERVICE_FEE_RECORDED: "LOAN_SERVICE_FEE_RECORDED",
  DEFAULT_CHARGES_STARTED: "DEFAULT_CHARGES_STARTED",
  DEFAULT_CHARGES_CHANGE_ACCEPTED: "DEFAULT_CHARGES_CHANGE_ACCEPTED",
  SECTION_129_CHARGE_STAMPED: "SECTION_129_CHARGE_STAMPED",
  DEFAULT_CHARGES_DISABLED: "DEFAULT_CHARGES_DISABLED",
  DEFAULT_CHARGES_EXEMPTION_CHANGED: "DEFAULT_CHARGES_EXEMPTION_CHANGED",
  // Sub-R1 residue closed by a non-cash WAIVER Payment (lib/loan/small-balance-waiver.ts)
  SMALL_BALANCE_WAIVED: "SMALL_BALANCE_WAIVED",

  // Bank reconciliation
  BANK_STATEMENT_IMPORTED: "BANK_STATEMENT_IMPORTED",
  BANK_TXN_RECONCILED: "BANK_TXN_RECONCILED",
  BANK_TXN_IGNORED: "BANK_TXN_IGNORED",

  // Client
  CLIENT_CREATED: "CLIENT_CREATED",
  CLIENT_UPDATED: "CLIENT_UPDATED",
  CLIENT_BLACKLISTED: "CLIENT_BLACKLISTED",
  // Recording a death is a records change, not a credit decision, and the trail
  // has to tell them apart — an estate is not a declined applicant.
  CLIENT_DECEASED_RECORDED: "CLIENT_DECEASED_RECORDED",

  // Consent (granular ClientConsent per-purpose changes — see lib/consent.ts)
  CONSENT_GRANTED: "CONSENT_GRANTED",
  CONSENT_WITHDRAWN: "CONSENT_WITHDRAWN",
  CONSENT_PURPOSE_CHANGED: "CONSENT_PURPOSE_CHANGED",

  // User management
  USER_CREATED: "USER_CREATED",
  USER_UPDATED: "USER_UPDATED",
  USER_DEACTIVATED: "USER_DEACTIVATED",
  USER_DELETED: "USER_DELETED",
  // A staff-user write stopped by the role ceiling (lib/auth-guards.ts).
  USER_WRITE_REFUSED: "USER_WRITE_REFUSED",

  // KYC
  KYC_APPROVED: "KYC_APPROVED",
  KYC_REJECTED: "KYC_REJECTED",
  KYC_STATUS_CHANGED: "KYC_STATUS_CHANGED",
  // One-time consumer selfie capture links. Distinct sent/failed actions for
  // the same reason PASQ_LINK_* are distinct: "we sent a credential to a
  // consumer" and "we minted one and cancelled it undelivered" are different
  // facts, and an auditor filtering on the first must not silently pick up the
  // second.
  SELFIE_LINK_SENT: "SELFIE_LINK_SENT",
  SELFIE_LINK_SEND_FAILED: "SELFIE_LINK_SEND_FAILED",
  // Signing links carry no credential — they route through /portal/continue —
  // so these record delivery of an invitation, not issuance of a token.
  AGREEMENT_SIGNING_LINK_SENT: "AGREEMENT_SIGNING_LINK_SENT",
  AGREEMENT_SIGNING_LINK_SEND_FAILED: "AGREEMENT_SIGNING_LINK_SEND_FAILED",
  BIOMETRIC_VERIFICATION_BLOCKED: "BIOMETRIC_VERIFICATION_BLOCKED",
  // A selfie attempt stuck in `processing` was failed by the sweeper while a
  // newer selfie governs the client, so the client's KYC was not re-projected
  // (lib/kyc/selfie-sweeper.server.ts).
  BIOMETRIC_ATTEMPT_SWEPT: "BIOMETRIC_ATTEMPT_SWEPT",
  KYC_VERIFICATION_BLOCKED: "KYC_VERIFICATION_BLOCKED",
  DOCUMENT_ACCESS_REFUSED: "DOCUMENT_ACCESS_REFUSED",
  KYC_EXCEPTION_GRANTED: "KYC_EXCEPTION_GRANTED",
  KYC_OVERRIDE_POLICY_UPDATED: "KYC_OVERRIDE_POLICY_UPDATED",
  KYC_OVERRIDE_REQUESTED: "KYC_OVERRIDE_REQUESTED",
  KYC_OVERRIDE_APPROVED: "KYC_OVERRIDE_APPROVED",
  KYC_OVERRIDE_DECLINED: "KYC_OVERRIDE_DECLINED",
  KYC_OVERRIDE_EXPIRED: "KYC_OVERRIDE_EXPIRED",
  KYC_IN_PERSON_VERIFICATION_GRANTED: "KYC_IN_PERSON_VERIFICATION_GRANTED",

  // Documents
  DOCUMENT_UPLOADED: "DOCUMENT_UPLOADED",
  DOCUMENT_VERIFIED: "DOCUMENT_VERIFIED",
  DOCUMENT_DELETED: "DOCUMENT_DELETED",
  DOCUMENT_SIGNED: "DOCUMENT_SIGNED",
  DOCUMENT_SIGNATURE_REQUESTED: "DOCUMENT_SIGNATURE_REQUESTED",
  DOCUMENT_DECRYPTED_AT_INTAKE: "DOCUMENT_DECRYPTED_AT_INTAKE",

  // Document templates
  DOCUMENT_TEMPLATE_CREATED: "DOCUMENT_TEMPLATE_CREATED",
  DOCUMENT_TEMPLATE_UPDATED: "DOCUMENT_TEMPLATE_UPDATED",
  NOTIFICATION_TEMPLATE_UPDATED: "NOTIFICATION_TEMPLATE_UPDATED",
  // A refused attempt to edit a migration-managed template. Recorded because
  // one of those rows is the NCA Section 129 notice, and "someone tried" is
  // exactly what an auditor asks about.
  NOTIFICATION_TEMPLATE_UPDATE_REFUSED: "NOTIFICATION_TEMPLATE_UPDATE_REFUSED",
  DOCUMENT_TEMPLATE_DELETED: "DOCUMENT_TEMPLATE_DELETED",

  // Document template versions (draft → dual-approval → publish)
  DOCUMENT_TEMPLATE_VERSION_CREATED: "DOCUMENT_TEMPLATE_VERSION_CREATED",
  DOCUMENT_TEMPLATE_VERSION_APPROVED: "DOCUMENT_TEMPLATE_VERSION_APPROVED",
  DOCUMENT_TEMPLATE_VERSION_ARCHIVED: "DOCUMENT_TEMPLATE_VERSION_ARCHIVED",
  DOCUMENT_TEMPLATE_VERSION_PUBLISHED: "DOCUMENT_TEMPLATE_VERSION_PUBLISHED",

  // Applications
  APPLICATION_SUBMITTED_BY_CLIENT: "APPLICATION_SUBMITTED_BY_CLIENT",
  APPLICATION_SUBMISSION_BLOCKED:  "APPLICATION_SUBMISSION_BLOCKED",
  APPLICATION_REVIEW_STARTED: "APPLICATION_REVIEW_STARTED",
  APPLICATION_BUREAU_REVIEW_RETRIED: "APPLICATION_BUREAU_REVIEW_RETRIED",
  // One bureau enquiry run (lib/compliance/bureau-review.ts): the bureaus
  // asked, in order, and how each attempt ended. No consumer data.
  BUREAU_ENQUIRY_RUN: "BUREAU_ENQUIRY_RUN",
  // Bureau enquiry settings (app/api/settings/bureau): order, freshness
  // window, and WHICH bureaus' credentials changed — never their values.
  BUREAU_ENQUIRY_CONFIG_UPDATED: "BUREAU_ENQUIRY_CONFIG_UPDATED",
  APPLICATION_RETURNED_TO_DRAFT: "APPLICATION_RETURNED_TO_DRAFT",
  APPLICATION_RETURNED_TO_REVIEW: "APPLICATION_RETURNED_TO_REVIEW",
  CREDIT_LIFE_ELECTION_RECORDED: "CREDIT_LIFE_ELECTION_RECORDED",

  // CRM / Leads
  // Public insurance enquiry captured from the website product page. The row
  // carries the POPIA contact consent that is the lawful basis for holding the
  // person's details — the form field itself is gone once the response is sent,
  // so this is the only evidence the agreement was given.
  INSURANCE_ENQUIRY_CAPTURED: "INSURANCE_ENQUIRY_CAPTURED",
  LEAD_CONVERTED: "LEAD_CONVERTED",
  LEAD_CONVERSION_RECOVERED: "LEAD_CONVERSION_RECOVERED",
  CONTACT_PROMOTED_LEAD_TO_CLIENT: "CONTACT_PROMOTED_LEAD_TO_CLIENT",
  CONTACT_REUSED_FOR_LEAD_CONVERSION: "CONTACT_REUSED_FOR_LEAD_CONVERSION",
  LEAD_STATUS_CHANGED: "LEAD_STATUS_CHANGED",
  LEAD_ACTIVITY_LOGGED: "LEAD_ACTIVITY_LOGGED",
  LEAD_ACTIVITY_PIN_TOGGLED: "LEAD_ACTIVITY_PIN_TOGGLED",
  LEAD_ASSIGNED: "LEAD_ASSIGNED",
  LEAD_OUTREACH_SENT: "LEAD_OUTREACH_SENT",
  LEAD_OUTREACH_SIMULATED: "LEAD_OUTREACH_SIMULATED",
  LEAD_OUTREACH_BLOCKED: "LEAD_OUTREACH_BLOCKED",
  LEAD_OUTREACH_RECONCILIATION_REQUIRED: "LEAD_OUTREACH_RECONCILIATION_REQUIRED",
  LEAD_OUTREACH_PENDING: "LEAD_OUTREACH_PENDING",
  LEAD_OUTREACH_NOT_SENT: "LEAD_OUTREACH_NOT_SENT",
  MESSAGE_DISPATCH_REARMED: "MESSAGE_DISPATCH_REARMED",
  MESSAGE_DISPATCH_EVIDENCE_RECOVERED: "MESSAGE_DISPATCH_EVIDENCE_RECOVERED",
  // An outbound the consumer needed never went out because eligibility
  // refused it. Enumeration-safe routes cannot tell the consumer, so the
  // durable record is the only way anyone finds out.
  MESSAGE_SEND_BLOCKED_BY_ELIGIBILITY: "MESSAGE_SEND_BLOCKED_BY_ELIGIBILITY",
  // An outbound the consumer needed failed for any other reason on a
  // fire-and-forget path. Same problem as the row above: nobody is waiting on
  // the promise, so without this the failure exists only in a console line.
  MESSAGE_SEND_FAILED_UNDELIVERED: "MESSAGE_SEND_FAILED_UNDELIVERED",
  REMINDER_DISPATCH_RECORDED: "REMINDER_DISPATCH_RECORDED",
  AGENT_TASK_CREATED: "AGENT_TASK_CREATED",
  AGENT_TASK_UPDATED: "AGENT_TASK_UPDATED",
  LEAD_TASK_REMINDER_SENT: "LEAD_TASK_REMINDER_SENT",
  LEAD_TASK_REMINDER_SIMULATED: "LEAD_TASK_REMINDER_SIMULATED",
  LEAD_TASK_REMINDER_PENDING: "LEAD_TASK_REMINDER_PENDING",
  LEAD_TASK_REMINDER_RECONCILIATION_REQUIRED: "LEAD_TASK_REMINDER_RECONCILIATION_REQUIRED",
  LEAD_TASK_REMINDER_FAILED: "LEAD_TASK_REMINDER_FAILED",
  NOTIFICATION_DATA_PURGED: "NOTIFICATION_DATA_PURGED",
  CROSS_SELL_OPPORTUNITIES_GENERATED: "CROSS_SELL_OPPORTUNITIES_GENERATED",

  // Credit / risk policy configuration
  CREDIT_POLICY_UPDATED: "CREDIT_POLICY_UPDATED",

  // Product configuration
  LOAN_PRODUCT_CREATED: "LOAN_PRODUCT_CREATED",
  LOAN_PRODUCT_UPDATED: "LOAN_PRODUCT_UPDATED",
  LOAN_PRODUCT_DEACTIVATED: "LOAN_PRODUCT_DEACTIVATED",
  INSURANCE_PRODUCT_CREATED: "INSURANCE_PRODUCT_CREATED",
  INSURANCE_PRODUCT_UPDATED: "INSURANCE_PRODUCT_UPDATED",
  INSURANCE_PRODUCT_DEACTIVATED: "INSURANCE_PRODUCT_DEACTIVATED",

  // IMS Phase 1: the insurer's rate card and acceptance terms. These are the
  // terms a quote is priced and screened against, so every change to them is
  // an auditable act — an activation in particular decides what every
  // subsequent policy is sold at.
  INSURANCE_RATE_TABLE_CREATED:      "INSURANCE_RATE_TABLE_CREATED",
  INSURANCE_RATE_TABLE_UPDATED:      "INSURANCE_RATE_TABLE_UPDATED",
  INSURANCE_RATE_TABLE_ACTIVATED:    "INSURANCE_RATE_TABLE_ACTIVATED",
  INSURANCE_RATE_TABLE_RETIRED:      "INSURANCE_RATE_TABLE_RETIRED",
  INSURANCE_RATE_TABLE_DELETED:      "INSURANCE_RATE_TABLE_DELETED",
  INSURANCE_RATE_BAND_CREATED:       "INSURANCE_RATE_BAND_CREATED",
  INSURANCE_RATE_BAND_UPDATED:       "INSURANCE_RATE_BAND_UPDATED",
  INSURANCE_RATE_BAND_DELETED:       "INSURANCE_RATE_BAND_DELETED",
  INSURANCE_ELIGIBILITY_RULE_CREATED: "INSURANCE_ELIGIBILITY_RULE_CREATED",
  INSURANCE_ELIGIBILITY_RULE_UPDATED: "INSURANCE_ELIGIBILITY_RULE_UPDATED",
  INSURANCE_ELIGIBILITY_RULE_DELETED: "INSURANCE_ELIGIBILITY_RULE_DELETED",
  // IMS Phase 2: quoting and the FAIS record of advice.
  //
  // INSURANCE_QUOTE_DRAFTED is not noise beside INSURANCE_QUOTE_CREATED — it
  // is the row that says a quote could NOT be priced or screened, and the
  // failures it carries are the evidence of what the insurer's configuration
  // refused. A quote that silently failed to price and left no trace is how an
  // operator concludes the product is broken with nothing to show anyone.
  INSURANCE_QUOTE_CREATED:           "INSURANCE_QUOTE_CREATED",
  INSURANCE_QUOTE_DRAFTED:           "INSURANCE_QUOTE_DRAFTED",
  INSURANCE_QUOTE_STATUS_CHANGED:    "INSURANCE_QUOTE_STATUS_CHANGED",
  INSURANCE_QUOTE_TRANSITION_REFUSED: "INSURANCE_QUOTE_TRANSITION_REFUSED",
  INSURANCE_ADVICE_RECORDED:         "INSURANCE_ADVICE_RECORDED",
  INSURANCE_ADVICE_REFUSED:          "INSURANCE_ADVICE_REFUSED",
  INSURANCE_QUOTE_DISCLOSURE_ISSUED: "INSURANCE_QUOTE_DISCLOSURE_ISSUED",
  INSURANCE_QUOTE_DISCLOSURE_REFUSED: "INSURANCE_QUOTE_DISCLOSURE_REFUSED",
  INSURANCE_QUOTE_BOUND:             "INSURANCE_QUOTE_BOUND",
  INSURANCE_QUOTE_BIND_REFUSED:      "INSURANCE_QUOTE_BIND_REFUSED",
  // The rating gate on the disclosure-draft path. A refusal here means a
  // premium was requested that the product's ACTIVE rate card does not
  // produce — recorded because it is an attempt to put a price in front of a
  // client that no insurer term supports.
  INSURANCE_DRAFT_RATING_REJECTED:   "INSURANCE_DRAFT_RATING_REJECTED",
  // Flipping the IMS module on or off for a tenant.
  //
  // It does NOT withdraw "the whole insurance API surface", which is what this
  // comment used to claim. `requireImsEnabled` gates app/api/insurance/**
  // only. With the flag off, app/api/insurers/**, app/api/products/insurance/**,
  // app/api/portal/insurance/**/ppr-acknowledge and app/api/cron/insurance-renewal
  // all still serve — deliberately, because live credit life reads insurer and
  // insurance-product records and gating them would break credit life.
  // Recorded because it opens and closes the gated surface plus the Insurance
  // and Compliance staff sections.
  IMS_MODULE_ENABLED:                "IMS_MODULE_ENABLED",
  IMS_MODULE_DISABLED:               "IMS_MODULE_DISABLED",
  BANK_SYNC_ENABLED:                 "BANK_SYNC_ENABLED",
  BANK_SYNC_DISABLED:                "BANK_SYNC_DISABLED",

  // Phase 2a: FAIS disclosure
  INSURANCE_FAIS_DISCLOSURE_RENDERED:     "INSURANCE_FAIS_DISCLOSURE_RENDERED",
  INSURANCE_FAIS_DISCLOSURE_ACKNOWLEDGED: "INSURANCE_FAIS_DISCLOSURE_ACKNOWLEDGED",
  INSURANCE_FAIS_GATE_REJECTED:           "INSURANCE_FAIS_GATE_REJECTED",
  INSURANCE_POLICY_AUTOBUNDLED:           "INSURANCE_POLICY_AUTOBUNDLED",
  INSURANCE_AUTOBUNDLE_SKIPPED:           "INSURANCE_AUTOBUNDLE_SKIPPED",
  INSURANCE_PATCH_FAIS_LOCKED:            "INSURANCE_PATCH_FAIS_LOCKED",
  // PPR / FAIS disclosure issued for an auto-bundled credit-life policy.
  INSURANCE_PPR_ISSUED:                   "INSURANCE_PPR_ISSUED",
  INSURANCE_PPR_ISSUE_FAILED:             "INSURANCE_PPR_ISSUE_FAILED",
  // Policyholder acknowledging the PPR disclosure themselves in the portal.
  // Before this, the ONLY writer of pprAcknowledgedAt was the staff route,
  // which took both the timestamp and the "acknowledged by" name from the
  // request body — an arbitrary, backdatable value asserted about a client who
  // may have done nothing. No UI ever called it, so in practice the FSCA
  // return's acknowledgement count (lib/fsca-return.ts) was zero by
  // construction — but any row that WAS written that way is indistinguishable
  // from a genuine acknowledgement and carries no audit row. Do not assume the
  // column is clean; see the legacy-row audit task before trusting it.
  INSURANCE_PPR_ACKNOWLEDGED:             "INSURANCE_PPR_ACKNOWLEDGED",
  // Insurance claim outcomes (money-committing state changes).
  INSURANCE_CLAIM_APPROVED:               "INSURANCE_CLAIM_APPROVED",
  INSURANCE_CLAIM_REJECTED:               "INSURANCE_CLAIM_REJECTED",
  INSURANCE_CLAIM_UPDATED:                "INSURANCE_CLAIM_UPDATED",
  // The submission that OPENS the claim. Its outcomes were audited above while
  // the event starting them was not, which left an approval in the log with no
  // recorded beginning.
  INSURANCE_CLAIM_SUBMITTED:              "INSURANCE_CLAIM_SUBMITTED",

  // Advisor commission lifecycle. Every one of these moves money or reverses
  // it: APPROVED clears a commission for payment, PAID asserts it left the
  // business, and CLAWED_BACK reverses it on a reason a human typed. The
  // clawback reason is kept in the audit row because it is the only record of
  // WHY the reversal was justified.
  INSURANCE_COMMISSIONS_CALCULATED:       "INSURANCE_COMMISSIONS_CALCULATED",
  INSURANCE_COMMISSION_APPROVED:          "INSURANCE_COMMISSION_APPROVED",
  INSURANCE_COMMISSION_PAID:              "INSURANCE_COMMISSION_PAID",
  INSURANCE_COMMISSION_CLAWED_BACK:       "INSURANCE_COMMISSION_CLAWED_BACK",

  // Who gets paid out on a death claim. The audited value deliberately omits
  // the beneficiary's idNumber and dateOfBirth: the audit trail exists to prove
  // who changed what, not to copy POPIA identifiers into a second store with a
  // different retention.
  INSURANCE_BENEFICIARY_ADDED:            "INSURANCE_BENEFICIARY_ADDED",
  INSURANCE_BENEFICIARY_REMOVED:          "INSURANCE_BENEFICIARY_REMOVED",

  // Admin Academy (user manual) — lesson progress
  MANUAL_LESSON_COMPLETED: "MANUAL_LESSON_COMPLETED",
  MANUAL_LESSON_REOPENED: "MANUAL_LESSON_REOPENED",

  // WhatsApp bridge pool
  WA_BRIDGE_NUMBER_ADDED: "WA_BRIDGE_NUMBER_ADDED",
  WA_BRIDGE_NUMBER_REORDERED: "WA_BRIDGE_NUMBER_REORDERED",
  WA_BRIDGE_NUMBER_PROMOTED: "WA_BRIDGE_NUMBER_PROMOTED",
  WA_BRIDGE_NUMBER_RETIRED: "WA_BRIDGE_NUMBER_RETIRED",
  // Re-pairing a revoked session. Distinct from ADDED: no new number entered
  // the pool, so an auditor reading ADDED rows sees only genuinely new numbers.
  WA_BRIDGE_NUMBER_RELINKED: "WA_BRIDGE_NUMBER_RELINKED",
  // Parked / un-parked. Distinct from RETIRED because the session survives —
  // an auditor asking "when did this number stop sending" needs to tell a
  // reversible bench from a destroyed pairing.
  WA_BRIDGE_NUMBER_PAUSED: "WA_BRIDGE_NUMBER_PAUSED",
  WA_BRIDGE_NUMBER_RESUMED: "WA_BRIDGE_NUMBER_RESUMED",
  // A WhatsApp outage was detected and NOT ONE recipient could be reached.
  // Email is currently the only alerting channel (the dashboard banner was
  // descoped), so this row is the last remaining trace that the detector
  // worked and the notification did not — otherwise the failure is a
  // console.error in an unretained container log, which is indistinguishable
  // from the six-day silence this whole feature exists to prevent.
  WA_BRIDGE_ALERT_UNDELIVERABLE: "WA_BRIDGE_ALERT_UNDELIVERABLE",

  // Comms internal notes
  COMMS_NOTE_ADDED: "COMMS_NOTE_ADDED",
  COMMS_NOTE_EDITED: "COMMS_NOTE_EDITED",
  COMMS_NOTE_DELETED: "COMMS_NOTE_DELETED",

  // Comms / inbox
  CONVERSATION_MERGED: "CONVERSATION_MERGED",

  // Email hub
  // Mail configuration is a money-and-notice path: the Section 129 statutory
  // notice goes out over whatever is configured here, so "who changed the
  // sending mailbox, and when" is an auditor question.
  EMAIL_CONFIG_UPDATED: "EMAIL_CONFIG_UPDATED",
  EMAIL_IMAP_TESTED: "EMAIL_IMAP_TESTED",
  // Backfill of the at-rest encryption for the EmailConfig secret columns.
  EMAIL_SECRETS_ENCRYPTED: "EMAIL_SECRETS_ENCRYPTED",

  // Bureau data submission (lib/bureau-submission). Counts and identifiers
  // only: an audit row never carries a line of the file.
  BUREAU_SUBMISSION_GENERATED: "BUREAU_SUBMISSION_GENERATED",
  BUREAU_SUBMISSION_DOWNLOADED: "BUREAU_SUBMISSION_DOWNLOADED",
  BUREAU_SUBMISSION_PUSHED: "BUREAU_SUBMISSION_PUSHED",
  BUREAU_ADVERSE_LISTING_CONFIRMED: "BUREAU_ADVERSE_LISTING_CONFIRMED",
  BUREAU_CONFIG_UPDATED: "BUREAU_CONFIG_UPDATED",
  // Breach log (the POPIA security-compromise register). The row keeps no
  // history of its own, so an edit's old values exist only in the audit row.
  BREACH_LOG_CREATED: "BREACH_LOG_CREATED",
  BREACH_LOG_UPDATED: "BREACH_LOG_UPDATED",
  // Tenant administration (app/api/admin/tenants).
  TENANT_CREATED: "TENANT_CREATED",
  TENANT_COLOURS_UPDATED: "TENANT_COLOURS_UPDATED",
  // Lender identity (lib/config/identity-write.ts) — legal name, NCR/FSP/
  // company-reg numbers, registered office and contact details.
  LENDER_IDENTITY_UPDATED: "LENDER_IDENTITY_UPDATED",
  // Letterhead logo (lib/config/lender-logo.ts): the file's sha256, never the bytes.
  LENDER_LOGO_UPDATED: "LENDER_LOGO_UPDATED",
  LENDER_LOGO_REMOVED: "LENDER_LOGO_REMOVED",
  // First SUPER_ADMIN of a lender and the break-glass reset of a locked-out
  // one (scripts/lender/bootstrap-admin.ts). Never carry a credential.
  SUPER_ADMIN_BOOTSTRAPPED: "SUPER_ADMIN_BOOTSTRAPPED",
  SUPER_ADMIN_BREAK_GLASS_RESET: "SUPER_ADMIN_BREAK_GLASS_RESET",

  // Complaints and POPIA data subject requests (app/api/complaints,
  // app/api/dsar). Identifiers, statuses and dates only: the description,
  // resolution and response stay on the row and are never copied here.
  COMPLAINT_CREATED: "COMPLAINT_CREATED",
  COMPLAINT_UPDATED: "COMPLAINT_UPDATED",
  DSAR_CREATED: "DSAR_CREATED",
  DSAR_UPDATED: "DSAR_UPDATED",
  // Branches (app/api/branches).
  BRANCH_CREATED: "BRANCH_CREATED",
  // Asset finance NCA regime (lib/asset-finance/classification.ts,
  // app/api/asset-finance). NON_NCA switches off the consumer rules, so who
  // classified, who asked to change it and who agreed are audit questions.
  NCA_CLASSIFIED: "NCA_CLASSIFIED",
  NCA_OVERRIDE_REQUESTED: "NCA_OVERRIDE_REQUESTED",
  NCA_OVERRIDE_DECIDED: "NCA_OVERRIDE_DECIDED",
  // A decision refused for lack of authority or by the four-eyes rule.
  NCA_OVERRIDE_DECISION_REFUSED: "NCA_OVERRIDE_DECISION_REFUSED",
  // A classification refused (not an entity borrower, or already decided).
  NCA_CLASSIFY_REFUSED: "NCA_CLASSIFY_REFUSED",
  // Asset register and suppliers (app/api/asset-finance/assets, /suppliers).
  ASSET_CREATED: "ASSET_CREATED",
  ASSET_UPDATED: "ASSET_UPDATED",
  // A serial/VIN already financed: a possible double-financing attempt.
  ASSET_DUPLICATE_REFUSED: "ASSET_DUPLICATE_REFUSED",
  ASSET_VALUATION_RECORDED: "ASSET_VALUATION_RECORDED",
  SUPPLIER_CREATED: "SUPPLIER_CREATED",
  SUPPLIER_UPDATED: "SUPPLIER_UPDATED",
  SUPPLIER_BANK_ACCOUNT_REQUESTED: "SUPPLIER_BANK_ACCOUNT_REQUESTED",
  SUPPLIER_BANK_ACCOUNT_DECIDED: "SUPPLIER_BANK_ACCOUNT_DECIDED",
  // A decision refused for lack of authority or by the four-eyes rule.
  SUPPLIER_BANK_ACCOUNT_DECISION_REFUSED: "SUPPLIER_BANK_ACCOUNT_DECISION_REFUSED",
  // Asset finance entity onboarding (app/api/asset-finance/entities,
  // app/api/portal/asset-finance). Entity documents are POPIA records; their
  // reads go to DocumentAccessLog, these rows record the changes.
  BUSINESS_ENTITY_CREATED: "BUSINESS_ENTITY_CREATED",
  BUSINESS_ENTITY_UPDATED: "BUSINESS_ENTITY_UPDATED",
  BUSINESS_ENTITY_UPDATE_REFUSED: "BUSINESS_ENTITY_UPDATE_REFUSED",
  ENTITY_RELATIONSHIP_ADDED: "ENTITY_RELATIONSHIP_ADDED",
  ENTITY_RELATIONSHIP_DEACTIVATED: "ENTITY_RELATIONSHIP_DEACTIVATED",
  ENTITY_DOCUMENT_UPLOADED: "ENTITY_DOCUMENT_UPLOADED",
  ENTITY_DOCUMENT_VERIFIED: "ENTITY_DOCUMENT_VERIFIED",
  ENTITY_DOCUMENT_DELETED: "ENTITY_DOCUMENT_DELETED",
  ENTITY_FINANCIALS_EVIDENCE_SET: "ENTITY_FINANCIALS_EVIDENCE_SET",
  // Asset finance deals (app/api/asset-finance/deals): origination, credit
  // memo, director/trustee bureau checks, submission and the credit decision.
  ASSET_DEAL_CREATED: "ASSET_DEAL_CREATED",
  ASSET_DEAL_SUBMITTED: "ASSET_DEAL_SUBMITTED",
  // Slice 1 finances non-NCA deals only: a deal that stays NCA is refused.
  ASSET_DEAL_REFUSED_NCA: "ASSET_DEAL_REFUSED_NCA",
  ASSET_DEAL_DECIDED: "ASSET_DEAL_DECIDED",
  // A decision refused for lack of authority.
  ASSET_DEAL_DECISION_REFUSED: "ASSET_DEAL_DECISION_REFUSED",
  ENTITY_FINANCIALS_RECORDED: "ENTITY_FINANCIALS_RECORDED",
  ASSET_AFFORDABILITY_ASSESSED: "ASSET_AFFORDABILITY_ASSESSED",
  ASSET_CREDIT_LIFE_ELECTED: "ASSET_CREDIT_LIFE_ELECTED",
  ASSET_NCA_QUOTE_ISSUED: "ASSET_NCA_QUOTE_ISSUED",
  ASSET_NCA_QUOTE_ACKNOWLEDGED: "ASSET_NCA_QUOTE_ACKNOWLEDGED",
  ASSET_SURRENDER_REQUESTED: "ASSET_SURRENDER_REQUESTED",
  ASSET_SURRENDER_VALUED: "ASSET_SURRENDER_VALUED",
  ASSET_SURRENDER_VALUATION_NOTICE_ISSUED: "ASSET_SURRENDER_VALUATION_NOTICE_ISSUED",
  ASSET_SURRENDER_PROCEEDS_CREDITED: "ASSET_SURRENDER_PROCEEDS_CREDITED",
  ASSET_SURRENDER_FINAL_NOTICE_ISSUED: "ASSET_SURRENDER_FINAL_NOTICE_ISSUED",
  ASSET_DEAL_BUREAU_CHECKED: "ASSET_DEAL_BUREAU_CHECKED",
  // A run with `force: true` (decide_asset_finance): people checked within the
  // last 30 days are checked again. A force asked for without that permission
  // is refused and recorded as ASSET_DEAL_BUREAU_FORCE_REFUSED.
  ASSET_DEAL_BUREAU_FORCED_RERUN: "ASSET_DEAL_BUREAU_FORCED_RERUN",
  ASSET_DEAL_BUREAU_FORCE_REFUSED: "ASSET_DEAL_BUREAU_FORCE_REFUSED",
  // Asset finance set-up (app/api/settings/asset-finance, app/api/asset-finance/vat-config):
  // the module switch, the payout dual-approval threshold and the VAT vendor details.
  ASSET_FINANCE_MODULE_ENABLED: "ASSET_FINANCE_MODULE_ENABLED",
  ASSET_FINANCE_MODULE_DISABLED: "ASSET_FINANCE_MODULE_DISABLED",
  ASSET_PAYOUT_DUAL_APPROVAL_CHANGED: "ASSET_PAYOUT_DUAL_APPROVAL_CHANGED",
  VAT_CONFIG_UPDATED: "VAT_CONFIG_UPDATED",
  // Deal documents and signing (lib/asset-finance/signing-*.ts): who prepared
  // the documents, each e-signature, each wet-ink scan and its confirmation by
  // a second user, and the move to CONTRACTED. Refusals (four eyes, signers
  // outstanding) are audited too. Document reads go to DocumentAccessLog.
  ASSET_DEAL_DOCUMENTS_PREPARED: "ASSET_DEAL_DOCUMENTS_PREPARED",
  ASSET_DEAL_DOCUMENT_SIGNED: "ASSET_DEAL_DOCUMENT_SIGNED",
  ASSET_DEAL_WET_INK_UPLOADED: "ASSET_DEAL_WET_INK_UPLOADED",
  ASSET_DEAL_WET_INK_CONFIRMED: "ASSET_DEAL_WET_INK_CONFIRMED",
  ASSET_DEAL_CONTRACTED: "ASSET_DEAL_CONTRACTED",
  ASSET_DEAL_SIGNING_REFUSED: "ASSET_DEAL_SIGNING_REFUSED",
  // Payout gate and booking (lib/asset-finance/payout*.ts, booking.ts): each
  // checklist confirmation with its evidence, the payout's creation and its
  // (second-user) approval, and the booking that creates the Loan and
  // releases the payout. Refusals of any of these are audited too.
  ASSET_PAYOUT_CHECKLIST_CONFIRMED: "ASSET_PAYOUT_CHECKLIST_CONFIRMED",
  ASSET_PAYOUT_CREATED: "ASSET_PAYOUT_CREATED",
  ASSET_PAYOUT_APPROVED: "ASSET_PAYOUT_APPROVED",
  ASSET_PAYOUT_REFUSED: "ASSET_PAYOUT_REFUSED",
  ASSET_DEAL_BOOKED: "ASSET_DEAL_BOOKED",
  // A deal cancelled before booking (lib/asset-finance/deal-cancel.ts): its
  // payout, application and asset with it. Refusals are audited too.
  ASSET_DEAL_CANCELLED: "ASSET_DEAL_CANCELLED",
  ASSET_DEAL_CANCEL_REFUSED: "ASSET_DEAL_CANCEL_REFUSED",
  // Operating and full-maintenance leases (slice 3): per-rental tax invoices
  // (lib/asset-finance/lease-invoices.ts), and a refusal the receipt path left.
  LEASE_RENTAL_INVOICED: "LEASE_RENTAL_INVOICED",
  LEASE_INVOICE_REFUSED: "LEASE_INVOICE_REFUSED",
  // Lease servicing (lib/asset-finance/maintenance-*.ts, meter-readings.ts,
  // lease-end-*.ts, lease-termination-store.ts, lease-daily.ts): the maintenance
  // fund and its claims, meter readings, the end of term and early termination.
  MAINTENANCE_CLAIM_SUBMITTED: "MAINTENANCE_CLAIM_SUBMITTED",
  MAINTENANCE_CLAIM_APPROVED: "MAINTENANCE_CLAIM_APPROVED",
  MAINTENANCE_CLAIM_REJECTED: "MAINTENANCE_CLAIM_REJECTED",
  MAINTENANCE_CLAIM_PAID: "MAINTENANCE_CLAIM_PAID",
  MAINTENANCE_FUND_SETTLED: "MAINTENANCE_FUND_SETTLED",
  METER_READING_RECORDED: "METER_READING_RECORDED",
  LEASE_EXPIRY_NOTICE_QUEUED: "LEASE_EXPIRY_NOTICE_QUEUED",
  LEASE_END_OF_TERM_ELECTED: "LEASE_END_OF_TERM_ELECTED",
  LEASE_INSPECTION_RECORDED: "LEASE_INSPECTION_RECORDED",
  LEASE_RETURNED: "LEASE_RETURNED",
  LEASE_EXTENDED: "LEASE_EXTENDED",
  LEASE_EXTENSION_ENDED: "LEASE_EXTENSION_ENDED",
  LEASE_PURCHASED: "LEASE_PURCHASED",
  LEASE_NATIS_CONFIRMED: "LEASE_NATIS_CONFIRMED",
  LEASE_EARLY_TERMINATION_QUOTED: "LEASE_EARLY_TERMINATION_QUOTED",
  LEASE_EARLY_TERMINATION_ACCEPTED: "LEASE_EARLY_TERMINATION_ACCEPTED",
  LEASE_CLOSED: "LEASE_CLOSED",
  LEASE_ACTION_REFUSED: "LEASE_ACTION_REFUSED",
  // A surety or signatory deactivation refused while the entity has an
  // approved deal (its signer set is fixed).
  ENTITY_RELATIONSHIP_CHANGE_REFUSED: "ENTITY_RELATIONSHIP_CHANGE_REFUSED",
  // Staff two-factor (lib/security/staff-totp-policy.ts, app/api/settings/totp,
  // app/api/settings/users/[id]/totp). Identifiers and the policy flag only,
  // never a secret or a code.
  STAFF_TOTP_POLICY_UPDATED: "STAFF_TOTP_POLICY_UPDATED",
  TOTP_ENROLLED: "TOTP_ENROLLED",
  TOTP_DISABLED: "TOTP_DISABLED",
  TOTP_REPLACED: "TOTP_REPLACED",
  // A refused attempt to turn off or replace 2FA (wrong or replayed code, or refused by policy).
  TOTP_CHANGE_REFUSED: "TOTP_CHANGE_REFUSED",
  TOTP_RESET_BY_ADMIN: "TOTP_RESET_BY_ADMIN",
  // PEP / sanctions screening (lib/screening). Types and results only: never
  // the matched list entries, which would put "possible PEP" in the audit view.
  SCREENING_RUN: "SCREENING_RUN",
  SCREENING_RUN_FAILED: "SCREENING_RUN_FAILED",
  SCREENING_MATCH_REVIEWED: "SCREENING_MATCH_REVIEWED",
  SCREENING_CONFIG_UPDATED: "SCREENING_CONFIG_UPDATED",
  SCREENING_BLOCK_LIFTED: "SCREENING_BLOCK_LIFTED",
  // An approval the screening gate refused (consumer decide route).
  SCREENING_APPROVAL_REFUSED: "SCREENING_APPROVAL_REFUSED",
  // FIC Act registers (lib/fic). STR rows carry the case id and status only:
  // the audit view is wider than the STR register, and naming the client
  // there would spread knowledge of the report (tipping-off risk).
  CTR_RECORDED: "CTR_RECORDED",
  FIC_EXPORTED: "FIC_EXPORTED",
  STR_CASE_RAISED: "STR_CASE_RAISED",
  STR_CASE_UPDATED: "STR_CASE_UPDATED",
  RMCP_UPLOADED: "RMCP_UPLOADED",
  RMCP_APPROVED: "RMCP_APPROVED",
  RMCP_DOWNLOADED: "RMCP_DOWNLOADED",
  // Staff working hours and IP allowlist (lib/security/staff-access-*.ts).
  // REFUSED: a sign-in or a live session stopped by the policy, with reason.
  // BYPASSED: a SUPER_ADMIN the policy would have stopped, let through.
  STAFF_ACCESS_POLICY_UPDATED: "STAFF_ACCESS_POLICY_UPDATED",
  STAFF_ACCESS_REFUSED: "STAFF_ACCESS_REFUSED",
  STAFF_ACCESS_BYPASSED: "STAFF_ACCESS_BYPASSED",
  // Signing OTP and portal registration policy (lib/signing-otp,
  // lib/portal/portal-policy.ts). Never the code itself.
  PORTAL_POLICY_UPDATED: "PORTAL_POLICY_UPDATED",
  SIGNING_OTP_REQUESTED: "SIGNING_OTP_REQUESTED",
  SIGNING_OTP_VERIFIED: "SIGNING_OTP_VERIFIED",
  SIGNING_OTP_REJECTED: "SIGNING_OTP_REJECTED",
} as const

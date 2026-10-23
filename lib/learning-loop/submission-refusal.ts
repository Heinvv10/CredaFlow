/**
 * Automated submission refusals in the decision log (docs/learning-loop/DESIGN.md,
 * decision 5 and §2.5). The portal and the public website refuse some
 * applications with no person involved: a recorded death, the blacklist,
 * arrears with this lender, expense evidence, and process refusals (an open
 * application, an identity conflict). Each refusal writes its
 * APPLICATION_SUBMISSION_BLOCKED audit row and a SYSTEM CreditDecisionRecord
 * together, in one transaction, flagged for the lender's POPIA s71 legal
 * review (a go-live gate, DESIGN.md §7).
 *
 * The refusal itself never changes: the client is refused whether or not the
 * record commits. On a best-effort site (the audit was `logAudit` before) a
 * failed record is logged and the audit row is still written alone, so the
 * log can never cost the trail a row it had. A strict site (the audit was
 * `logAuditStrict`) throws, as it did.
 *
 * The snapshot is an allow-list: channel, reason and its class. No amount,
 * income, identity value or free text reaches the record.
 */
import { prisma } from "@/lib/prisma"
import { AuditAction, logAudit, logAuditStrict } from "@/lib/audit"
import { DECISION_LOG_VERSION, recordDecisions, type DecisionRecordInput } from "./decision-log"

export const SUBMISSION_REFUSAL_RULE_VERSION = "submission-refusal-v1"

/**
 * Every reason an automated refusal writes, and its class. CREDIT: a rule
 * about the applicant's credit standing or affordability evidence, the
 * s71 case. PROCESS: the submission could not be taken as it stands
 * (duplicate, unconfirmed identity, unauthenticated profile change).
 */
export const SUBMISSION_REFUSAL_REASONS = {
  client_blacklisted: "CREDIT",
  client_deceased: "CREDIT",
  own_lender_arrears: "CREDIT",
  mle_justification_missing: "CREDIT",
  expense_evidence_invalid: "CREDIT",
  open_application_exists: "PROCESS",
  identity_conflict: "PROCESS",
  financial_profile_update_requires_authentication: "PROCESS",
  contact_promotion_conflict: "PROCESS",
} as const
export type SubmissionRefusalReason = keyof typeof SUBMISSION_REFUSAL_REASONS

export function isSubmissionRefusalReason(value: string): value is SubmissionRefusalReason {
  return Object.hasOwn(SUBMISSION_REFUSAL_REASONS, value)
}

type AuditParams = Parameters<typeof logAuditStrict>[0]

export interface SubmissionRefusal {
  tenantId: string
  channel: "PORTAL" | "WEBSITE"
  reason: SubmissionRefusalReason
  /** A confirmed client, else the website lead; never a client the request only claimed to match. */
  subject: { clientId: string } | { leadId: string }
  /** The open application a duplicate collided with (evidence, not the subject). */
  existingApplicationId?: string
  decidedAt?: Date
}

export function submissionRefusalRecord(refusal: SubmissionRefusal): DecisionRecordInput {
  const [subject, source] = "clientId" in refusal.subject
    ? [{ clientId: refusal.subject.clientId }, { entityType: "Client", entityId: refusal.subject.clientId }]
    : [{ leadId: refusal.subject.leadId }, { entityType: "Lead", entityId: refusal.subject.leadId }]
  const snapshot = {
    channel: refusal.channel,
    refusalReason: refusal.reason,
    refusalClass: SUBMISSION_REFUSAL_REASONS[refusal.reason],
    automated: true,
  }
  return {
    tenantId: refusal.tenantId,
    kind: "CREDIT_DECISION",
    decision: "DECLINE",
    recommendation: "BLOCK",
    overrideReason: null,
    actor: { type: "SYSTEM" },
    subject,
    source,
    ruleVersion: `${DECISION_LOG_VERSION}+${SUBMISSION_REFUSAL_RULE_VERSION}`,
    policy: {},
    snapshot,
    evidenceRefs: {
      auditAction: AuditAction.APPLICATION_SUBMISSION_BLOCKED,
      ...(refusal.existingApplicationId ? { existingApplicationId: refusal.existingApplicationId } : {}),
    },
    exactInputs: { channel: refusal.channel, reason: refusal.reason },
    decidedAt: refusal.decidedAt ?? new Date(),
    s71ReviewRequired: true,
  }
}

/**
 * Writes the refusal's audit row and its SYSTEM decision record in one
 * transaction. `strict`: throw on failure (the site used logAuditStrict).
 * Otherwise a failure is logged, the audit row is written alone, and a
 * DECISION_RECORD_WRITE_FAILED row marks the missing record.
 */
export async function recordSubmissionRefusal(
  audit: AuditParams,
  refusal: SubmissionRefusal,
  options: { strict?: boolean } = {},
): Promise<void> {
  const record = submissionRefusalRecord(refusal)
  try {
    await prisma.$transaction(async (tx) => {
      await logAuditStrict(audit, tx)
      await recordDecisions(tx, [record])
    })
  } catch (error) {
    if (options.strict) throw error
    console.error(
      "[learning-loop] automated refusal record failed; writing the audit row alone:",
      { tenantId: refusal.tenantId, channel: refusal.channel, reason: refusal.reason },
      error,
    )
    await logAudit(audit)
    // The gap leaves its own durable row (ids and codes only, never the error text): the dashboard counts it.
    await logAudit({
      tenantId: refusal.tenantId,
      action: AuditAction.DECISION_RECORD_WRITE_FAILED,
      entity: "CreditDecisionRecord",
      newValue: {
        tenantId: refusal.tenantId,
        channel: refusal.channel,
        reason: refusal.reason,
        subjectId: "clientId" in refusal.subject ? refusal.subject.clientId : refusal.subject.leadId,
      },
    })
  }
}

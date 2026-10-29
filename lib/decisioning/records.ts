import type { DeclineCategory } from "@prisma/client"
import { DECISION_LOG_VERSION, type DecisionRecordInput } from "@/lib/learning-loop/decision-log"
import type { DecisionFacts } from "./facts"
import type { AutoDecisionRole } from "@prisma/client"

export const DECISIONING_VERSION = "decisioning-v1"

export interface AutoRecordFacts {
  tenantId: string
  applicationId: string
  clientId: string | null
  decision: "DECLINE" | "REFER"
  reasonCodes: readonly string[]
  declineCategory: DeclineCategory | null
  riskGrade: string | null
  role: AutoDecisionRole
  version: { id: string; scopeKey: string; version: number }
  bureauCheckId: string | null
  facts: DecisionFacts
  decidedAt: Date
}

/** The rule-set label a decision carries in the log and the audit trail: "<scope>:v<N>". */
export const versionLabel = (v: { scopeKey: string; version: number }) => `${v.scopeKey}:v${v.version}`

/**
 * The decision log record for a decision the rules engine takes alone (a
 * decline or a referral; an approval is recorded by the staff approval path
 * itself, flagged as automated). SYSTEM actor, so a decline awaits the
 * lender's POPIA s71 review (DB CHECK: only SYSTEM rows carry the flag).
 * The snapshot holds codes and a grade, never amounts or identifiers; the
 * exact facts are hashed, not stored (lib/learning-loop/.claude.md).
 */
export function autoDecisionRecord(f: AutoRecordFacts): DecisionRecordInput {
  const { productId: _productId, productCode: _productCode, ...exact } = f.facts
  return {
    tenantId: f.tenantId,
    kind: "CREDIT_DECISION",
    decision: f.decision,
    recommendation: f.decision === "DECLINE" ? "BLOCK" : "REFER",
    overrideReason: null,
    actor: { type: "SYSTEM" },
    subject: { applicationId: f.applicationId, clientId: f.clientId },
    source: { entityType: "LoanApplication", entityId: f.applicationId },
    ruleVersion: `${DECISION_LOG_VERSION}+${DECISIONING_VERSION}+${versionLabel(f.version)}`,
    policy: { ruleSetVersionId: f.version.id },
    snapshot: {
      reasonCodes: [...f.reasonCodes],
      riskGrade: f.riskGrade,
      role: f.role,
      ...(f.declineCategory ? { declineCategory: f.declineCategory } : {}),
    },
    evidenceRefs: { ruleSetVersionId: f.version.id, bureauCheckId: f.bureauCheckId },
    exactInputs: exact,
    decidedAt: f.decidedAt,
    s71ReviewRequired: f.decision === "DECLINE",
  }
}

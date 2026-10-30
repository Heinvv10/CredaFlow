import { DECISION_LOG_VERSION, type DecisionRecordInput } from "@/lib/learning-loop/decision-log"
import type { AutoDecisionRole } from "@prisma/client"
import type { DecisionFacts } from "./facts"

export const DECISIONING_VERSION = "decisioning-v1"

export interface ReferRecordFacts {
  tenantId: string
  applicationId: string
  clientId: string | null
  reasonCodes: readonly string[]
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
 * The decision log record for a referral the rules engine makes alone (the
 * application stays with staff). A decline and an approval are recorded by the
 * staff decision path itself, flagged as automated (lib/learning-loop/records.ts).
 * SYSTEM actor; the snapshot holds codes and a grade, never amounts or
 * identifiers, and the exact facts are hashed, not stored
 * (lib/learning-loop/.claude.md).
 */
export function referRecord(f: ReferRecordFacts): DecisionRecordInput {
  const { productId: _productId, productCode: _productCode, ...exact } = f.facts
  return {
    tenantId: f.tenantId,
    kind: "CREDIT_DECISION",
    decision: "REFER",
    recommendation: "REFER",
    overrideReason: null,
    actor: { type: "SYSTEM" },
    subject: { applicationId: f.applicationId, clientId: f.clientId },
    source: { entityType: "LoanApplication", entityId: f.applicationId },
    ruleVersion: `${DECISION_LOG_VERSION}+${DECISIONING_VERSION}+${versionLabel(f.version)}`,
    policy: { ruleSetVersionId: f.version.id },
    snapshot: { reasonCodes: [...f.reasonCodes], riskGrade: f.riskGrade, role: f.role },
    evidenceRefs: { ruleSetVersionId: f.version.id, bureauCheckId: f.bureauCheckId },
    exactInputs: exact,
    decidedAt: f.decidedAt,
  }
}

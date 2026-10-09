import type { AffordabilityDecisionSnapshot } from "@/lib/affordability/snapshot"

type ApprovalSnapshot = Pick<AffordabilityDecisionSnapshot, "stage" | "bureauEvidence">

export interface BureauComplianceRecord {
  status: string
  data: unknown
  createdAt: Date
  completedAt: Date | null
}

export interface BureauOverrideDisplay {
  reason: string
  byId: string
  recordedAt: Date
}

export type BureauDisplay =
  | {
      kind: "CHECK"
      source: "APPROVAL_SNAPSHOT" | "CURRENT_REVIEW"
      provider: string
      score: number | null
      riskGrade: string | null
      adverseInfo: string[]
      unscoreable: boolean
      checkedAt: Date
      override: BureauOverrideDisplay | null
    }
  | {
      kind: "OVERRIDE"
      override: BureauOverrideDisplay
    }
  | {
      kind: "SKIPPED"
      reason: string | null
    }
  | {
      kind: "PENDING"
      error: string | null
    }
  | {
      kind: "MISSING"
      immutable: boolean
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function snapshotAdverseInfo(
  check: NonNullable<NonNullable<ApprovalSnapshot["bureauEvidence"]>["check"]>,
): string[] {
  const adverseInfo = [
    check.deceased ? "Consumer reported deceased" : null,
    check.underDebtReview ? "Consumer under debt review" : null,
    check.hasJudgement ? "Judgement recorded" : null,
    check.hasNotice ? "Adverse notice recorded" : null,
  ].filter((item): item is string => item !== null)

  if (check.hasAdverse && adverseInfo.length === 0) {
    adverseInfo.push("Adverse information reported")
  }
  return adverseInfo
}

/**
 * Approved and disbursed applications must render the bureau evidence sealed
 * into their immutable approval snapshot. A current/historical compliance row
 * is deliberately never substituted for that legal decision record.
 */
export function resolveBureauDisplay(args: {
  applicationStatus: string
  approvalSnapshot: ApprovalSnapshot | null
  complianceRecord: BureauComplianceRecord | null
}): BureauDisplay {
  const approvalEvidenceRequired = ["APPROVED", "DISBURSED"].includes(
    args.applicationStatus,
  )

  if (approvalEvidenceRequired) {
    const snapshot = args.approvalSnapshot
    if (!snapshot || snapshot.stage !== "APPROVAL" || !snapshot.bureauEvidence) {
      return { kind: "MISSING", immutable: true }
    }

    const evidence = snapshot.bureauEvidence
    const override = evidence.override
      ? {
          reason: evidence.override.reason,
          byId: evidence.override.byId,
          recordedAt: new Date(evidence.override.at),
        }
      : null
    if (evidence.mode === "OVERRIDE") {
      if (!override) return { kind: "MISSING", immutable: true }
      if (!evidence.check) return { kind: "OVERRIDE", override }
    }

    if (!evidence.check) return { kind: "MISSING", immutable: true }
    return {
      kind: "CHECK",
      source: "APPROVAL_SNAPSHOT",
      provider: evidence.check.provider,
      score: evidence.check.score,
      riskGrade: evidence.check.riskGrade,
      adverseInfo: snapshotAdverseInfo(evidence.check),
      unscoreable: evidence.check.unscoreable,
      checkedAt: new Date(evidence.check.createdAt),
      override,
    }
  }

  const record = args.complianceRecord
  if (!record) return { kind: "MISSING", immutable: false }
  const data = isRecord(record.data) ? record.data : {}
  if (data.skipped === true) {
    return {
      kind: "SKIPPED",
      reason: typeof data.reason === "string" ? data.reason : null,
    }
  }
  if (record.status === "PENDING") {
    return {
      kind: "PENDING",
      error: typeof data.error === "string" ? data.error : null,
    }
  }

  return {
    kind: "CHECK",
    source: "CURRENT_REVIEW",
    provider: typeof data.provider === "string" ? data.provider : "Experian",
    score: typeof data.score === "number" ? data.score : null,
    riskGrade: typeof data.riskGrade === "string" ? data.riskGrade : null,
    adverseInfo: Array.isArray(data.adverseInfo)
      ? data.adverseInfo.filter((item): item is string => typeof item === "string")
      : [],
    unscoreable: data.unscoreable === true,
    checkedAt: record.completedAt ?? record.createdAt,
    override: null,
  }
}

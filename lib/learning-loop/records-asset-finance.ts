/**
 * The asset-finance deal decision (lib/asset-finance/deal-decision.ts) as
 * decision records, built from named facts only (see ./records.ts). The
 * deal's gates (credit memo, NCA s81 assessment, credit-life election,
 * screening) block an approval; only its exceptions (internal arrears, a
 * related party's bureau check missing) can be approved past, with a reason.
 */
import { DECISION_LOG_VERSION, amountBand, ratioBand, type DecisionRecordInput } from "./decision-log"
import type { StaffActor } from "./records"

export const ASSET_FINANCE_DECISION_RULES = "af-deal-decision-v1"

const DSCR_EDGES = [1, 1.25, 1.5, 2] as const
const GEARING_EDGES = [0.25, 0.5, 1, 2] as const

export interface AssetFinanceDecisionFacts {
  tenantId: string
  dealId: string
  applicationId: string
  /** Null when the borrower is a business entity. */
  clientId: string | null
  actor: StaffActor
  decidedAt: Date
  decision: "APPROVE" | "DECLINE" | "REFER"
  ncaRegime: string | null
  productType: string
  appliedAmountCents: number
  appliedTermDays: number
  dscr: number | null
  gearing: number | null
  creditMemo: boolean
  /** Null when no s81 assessment is recorded. */
  s81Affordable: boolean | null
  /** Exception kinds only (ARREARS, BUREAU); their keys name related parties. Loaded on APPROVE only. */
  exceptionKinds: readonly string[]
  exceptionsFingerprint: string | null
  exceptionReason: string | null
}

export function assetFinanceDecisionRecords(f: AssetFinanceDecisionFacts): DecisionRecordInput[] {
  const approve = f.decision === "APPROVE"
  const hasExceptions = f.exceptionKinds.length > 0
  const recommendation = !approve ? "NONE" : hasExceptions ? "REFER" : "PASS"
  const exceptionCounts = Object.fromEntries(
    [...new Set(f.exceptionKinds)].sort().map((kind) => [kind, f.exceptionKinds.filter((k) => k === kind).length]),
  )
  const s81 = f.ncaRegime === "NON_NCA" ? "NOT_APPLICABLE" : f.s81Affordable === null ? "MISSING" : f.s81Affordable ? "PASS" : "BLOCK"
  const base = {
    tenantId: f.tenantId,
    actor: { type: "STAFF" as const, userId: f.actor.userId, role: f.actor.role },
    subject: { applicationId: f.applicationId, clientId: f.clientId },
    source: { entityType: "AssetFinanceDeal", entityId: f.dealId },
    ruleVersion: `${DECISION_LOG_VERSION}+${ASSET_FINANCE_DECISION_RULES}`,
    // No tenant threshold drives this decision today; the code version is the policy.
    policy: { rules: ASSET_FINANCE_DECISION_RULES },
    evidenceRefs: { assetFinanceDealId: f.dealId, exceptionsFingerprint: f.exceptionsFingerprint },
    exactInputs: {
      decision: f.decision,
      ncaRegime: f.ncaRegime,
      productType: f.productType,
      appliedAmountCents: f.appliedAmountCents,
      appliedTermDays: f.appliedTermDays,
      dscr: f.dscr,
      gearing: f.gearing,
      creditMemo: f.creditMemo,
      s81Affordable: f.s81Affordable,
      exceptionCounts,
    },
    decidedAt: f.decidedAt,
  }
  const decision: DecisionRecordInput = {
    ...base,
    kind: "CREDIT_DECISION",
    decision: f.decision,
    recommendation,
    overrideReason: approve && hasExceptions ? f.exceptionReason : null,
    snapshot: {
      productType: f.productType,
      ncaRegime: f.ncaRegime,
      amountBand: amountBand(f.appliedAmountCents),
      termDays: f.appliedTermDays,
      dscrBand: ratioBand(f.dscr, DSCR_EDGES),
      gearingBand: ratioBand(f.gearing, GEARING_EDGES),
      creditMemo: f.creditMemo,
      s81,
      exceptions: approve ? exceptionCounts : null,
    },
  }
  if (!approve) return [decision]
  const offer: DecisionRecordInput = {
    ...base,
    kind: "OFFER",
    decision: "APPROVED_TERMS",
    recommendation: "NONE",
    overrideReason: null,
    snapshot: {
      productType: f.productType,
      ncaRegime: f.ncaRegime,
      amountBand: amountBand(f.appliedAmountCents),
      termDays: f.appliedTermDays,
      repaymentMethod: "EFT",
    },
  }
  return [decision, offer]
}

/**
 * The decision log writer (docs/learning-loop/DESIGN.md). One append-only
 * CreditDecisionRecord row per decision event, written with the caller's
 * transaction client so the decision and its record commit or roll back
 * together. The database refuses UPDATE, DELETE and TRUNCATE on the table
 * (migration 20261021090000_credit_decision_record).
 *
 * ./records.ts builds every input by reading named fields (an allow-list):
 * a row handed to a builder is never spread, so its other columns cannot
 * reach the log. The snapshot holds bands, gate outcomes and thresholds
 * only. `exactInputs` is hashed and never stored.
 */
import { createHash } from "node:crypto"
import type { DecisionRecommendation, DecisionRecordKind, Prisma } from "@prisma/client"
import { canonicalJson } from "@/lib/canonical-json"
import type { prisma } from "@/lib/prisma"

export const DECISION_LOG_VERSION = "decision-log-v1"

export const DECISION_CODES = [
  "APPROVE",
  "DECLINE",
  "REFER",
  "RETURN_TO_REVIEW",
  "RETURN_TO_DRAFT",
  "CLEAR_FLAG",
  "APPROVED_TERMS",
  "QUOTATION_ISSUED",
] as const
export type DecisionCode = (typeof DECISION_CODES)[number]

/** JSON a snapshot may hold: no Date, Decimal or class instance (canonicalJson would print `{}`). */
export type Plain = string | number | boolean | null | Plain[] | { [key: string]: Plain }

export type DecisionActor =
  | { type: "STAFF"; userId: string; role: string | null }
  | { type: "SYSTEM" }

export interface DecisionRecordInput {
  tenantId: string
  kind: DecisionRecordKind
  decision: DecisionCode
  recommendation: DecisionRecommendation
  /** Set exactly when the person went against a gate. */
  overrideReason: string | null
  actor: DecisionActor
  subject: { applicationId?: string | null; loanId?: string | null; clientId?: string | null; leadId?: string | null }
  source: { entityType: string; entityId: string }
  ruleVersion: string
  /** The tenant's effective thresholds the decision used; stored as a hash. */
  policy: { [key: string]: Plain }
  snapshot: { [key: string]: Plain }
  evidenceRefs: { [key: string]: Plain }
  /** The exact (unbanded) inputs: hashed into inputsHash, never stored. */
  exactInputs: { [key: string]: Plain }
  decidedAt: Date
  /** An automated decision awaiting the lender's POPIA s71 legal review (SYSTEM only; DB CHECK). */
  s71ReviewRequired?: boolean
}

/** The app client or its transaction client (as logAuditStrict in lib/audit.ts). */
export type DecisionLogDb = Pick<typeof prisma, "creditDecisionRecord">

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function policyHash(policy: { [key: string]: Plain }): string {
  return sha256Hex(canonicalJson(policy))
}

/** The hash of the full input: the exact values, the evidence references and the policy in force. */
export function inputsHash(input: Pick<DecisionRecordInput, "exactInputs" | "evidenceRefs" | "policy">): string {
  return sha256Hex(canonicalJson({ exactInputs: input.exactInputs, evidenceRefs: input.evidenceRefs, policy: input.policy }))
}

export function recordData(input: DecisionRecordInput): Prisma.CreditDecisionRecordUncheckedCreateInput {
  const reason = input.overrideReason?.trim() || null
  return {
    tenantId: input.tenantId,
    kind: input.kind,
    decision: input.decision,
    recommendation: input.recommendation,
    overridden: reason !== null,
    overrideReason: reason,
    actorType: input.actor.type,
    actorUserId: input.actor.type === "STAFF" ? input.actor.userId : null,
    actorRole: input.actor.type === "STAFF" ? input.actor.role : null,
    applicationId: input.subject.applicationId ?? null,
    loanId: input.subject.loanId ?? null,
    clientId: input.subject.clientId ?? null,
    leadId: input.subject.leadId ?? null,
    sourceEntityType: input.source.entityType,
    sourceEntityId: input.source.entityId,
    ruleVersion: input.ruleVersion,
    policyHash: policyHash(input.policy),
    modelVersion: null,
    predictedProbability: null,
    inputsSnapshot: input.snapshot,
    evidenceRefs: input.evidenceRefs,
    inputsHash: inputsHash(input),
    decidedAt: input.decidedAt,
    s71ReviewRequired: input.s71ReviewRequired ?? false,
  }
}

/**
 * Writes the records in the caller's transaction. A failure throws: a credit
 * decision fails closed rather than commit without its record.
 */
export async function recordDecisions(db: DecisionLogDb, inputs: readonly DecisionRecordInput[]): Promise<void> {
  for (const input of inputs) {
    await db.creditDecisionRecord.create({ data: recordData(input) })
  }
}

// ── Bands ────────────────────────────────────────────────────────────────────
// Coarse enough that a band names no one, fine enough to cut outcomes by.

function band(value: number, edges: readonly number[]): string {
  if (value < edges[0]) return `<${edges[0]}`
  for (let i = 1; i < edges.length; i++) {
    if (value < edges[i]) return `${edges[i - 1]}-${edges[i] - 1}`
  }
  return `${edges[edges.length - 1]}+`
}

const AMOUNT_EDGES_RAND = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 1_000_000] as const
const INCOME_EDGES_RAND = [5_000, 10_000, 20_000, 40_000, 80_000] as const
const INSTALMENT_EDGES_RAND = [500, 1_000, 2_500, 5_000, 10_000, 25_000] as const
const BUREAU_EDGES = [480, 530, 580, 630, 680] as const

/** Principal, in rands, from cents. */
export const amountBand = (cents: number) => band(Math.floor(cents / 100), AMOUNT_EDGES_RAND)
export const incomeBand = (cents: number) => band(Math.floor(cents / 100), INCOME_EDGES_RAND)
export const instalmentBand = (cents: number) => band(Math.floor(cents / 100), INSTALMENT_EDGES_RAND)
/** Experian Sigma score (480-710) in 50-point bands; null when there is no score. */
export const bureauScoreBand = (score: number | null) => (score === null ? null : band(score, BUREAU_EDGES))

/** NDI as a multiple of the NDI the gate required, in steps. */
export function ndiCoverBand(ndiCents: number, requiredNdiCents: number): string | null {
  if (requiredNdiCents <= 0) return null
  const ratio = ndiCents / requiredNdiCents
  if (ratio < 1) return "<1.00"
  if (ratio < 1.25) return "1.00-1.24"
  if (ratio < 1.5) return "1.25-1.49"
  if (ratio < 2) return "1.50-1.99"
  if (ratio < 3) return "2.00-2.99"
  return "3.00+"
}

/** A business ratio (DSCR, gearing) in steps. */
export function ratioBand(value: number | null, edges: readonly number[]): string | null {
  if (value === null || !Number.isFinite(value)) return null
  if (value < edges[0]) return `<${edges[0]}`
  for (let i = 1; i < edges.length; i++) {
    if (value < edges[i]) return `${edges[i - 1]}-${edges[i]}`
  }
  return `${edges[edges.length - 1]}+`
}

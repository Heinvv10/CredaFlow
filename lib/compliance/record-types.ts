/**
 * Classification of `ComplianceType` for the compliance dashboard.
 *
 * The dashboard used to score "compliance health" as completed ÷ ALL records,
 * over every type. That is not a compliance measure. Most rows in the table are
 * per-application evidence produced by the loan lifecycle — a `CREDIT_BUREAU_CHECK`
 * left PENDING on an abandoned application is not an unmet legal obligation, but
 * it dragged the headline down permanently and the number drifted with loan
 * volume, reading "At Risk" while every statutory tab held zero records.
 *
 * Three groups, because they answer three different questions:
 *
 * - OBLIGATION — a statutory duty with a completion state and usually a
 *   deadline. These, and only these, drive the health score.
 * - EXCEPTION — something that needs clearing by a human. Surfaced as its own
 *   count so it cannot hide, but it is not a filing and does not belong in a
 *   filing percentage.
 * - REGISTER — immutable evidence of what the system did. `PENDING` here is a
 *   lifecycle stage, never a breach.
 * - LEGACY — enum values nothing in the app writes. The evidence they name is
 *   real but lives in another model (see LEGACY_EVIDENCE_HOME). They stay in
 *   the enum because Postgres cannot drop an enum value and dev seeds still
 *   insert them; they are never scored, so a hand-entered row through the
 *   generic POST /api/compliance cannot move the health figure.
 *
 * `Record<ComplianceType, …>` is deliberate: adding a value to the enum without
 * classifying it fails the build. The previous hardcoded list of five types
 * covered 5 of 13 and silently made the other 8 unreachable by any filter.
 */

import type { ComplianceType, ComplianceStatus } from "@prisma/client"

export type ComplianceGroup = "OBLIGATION" | "EXCEPTION" | "REGISTER" | "LEGACY"

export const COMPLIANCE_TYPE_GROUP: Record<ComplianceType, ComplianceGroup> = {
  SECTION_129_NOTICE: "OBLIGATION",
  NCR_QUARTERLY_RETURN: "OBLIGATION",
  FSCA_QUARTERLY_RETURN: "OBLIGATION",
  FAIS_DISCLOSURE: "OBLIGATION",
  FORM_20_PRE_AGREEMENT: "LEGACY",
  POPIA_CONSENT: "LEGACY",
  AFFORDABILITY_ASSESSMENT: "LEGACY",
  COMPLAINT: "LEGACY",
  DISBURSEMENT_EXCEPTION: "EXCEPTION",
  KYC_EXCEPTION: "EXCEPTION",
  AGREEMENT_ARTIFACT: "REGISTER",
  DEBIT_MANDATE_ARTIFACT: "REGISTER",
  CREDIT_BUREAU_CHECK: "REGISTER",
}

export const COMPLIANCE_TYPE_LABEL: Record<ComplianceType, string> = {
  FORM_20_PRE_AGREEMENT: "Form 20 — Pre-Agreement",
  SECTION_129_NOTICE: "S.129 Notice",
  NCR_QUARTERLY_RETURN: "NCR Quarterly Return",
  FSCA_QUARTERLY_RETURN: "FSCA Quarterly Return",
  POPIA_CONSENT: "POPIA Consent",
  FAIS_DISCLOSURE: "FAIS Disclosure",
  AFFORDABILITY_ASSESSMENT: "Affordability Assessment",
  COMPLAINT: "Complaint",
  DISBURSEMENT_EXCEPTION: "Disbursement Exception",
  KYC_EXCEPTION: "KYC Exception",
  AGREEMENT_ARTIFACT: "Credit Agreement Artifact",
  DEBIT_MANDATE_ARTIFACT: "Debit Mandate Artifact",
  CREDIT_BUREAU_CHECK: "Credit Bureau Check",
}

/**
 * Where the evidence for each LEGACY type actually lives. Verified by grepping
 * every `complianceRecord.create` site (including named-constant indirection):
 * none of these four has a writer (the demo seeds no longer invent them either).
 */
export const LEGACY_EVIDENCE_HOME = {
  FORM_20_PRE_AGREEMENT: "Form 20 is a signed ClientDocument (docType FORM_20_PRE_AGREEMENT) on the application",
  POPIA_CONSENT: "Consent is recorded in ConsentRecord on the client",
  AFFORDABILITY_ASSESSMENT: "Affordability is recorded on the LoanApplication",
  COMPLAINT: "Complaints are recorded in the Complaint register",
} as const satisfies Partial<Record<ComplianceType, string>>

export type LegacyComplianceType = keyof typeof LEGACY_EVIDENCE_HOME

export function legacyEvidenceHome(type: string): string | null {
  return Object.hasOwn(LEGACY_EVIDENCE_HOME, type)
    ? LEGACY_EVIDENCE_HOME[type as LegacyComplianceType]
    : null
}

/**
 * Statuses that close a record out. ACKNOWLEDGED belongs here: an acknowledged
 * Section 129 notice is a discharged obligation, and omitting it counted a
 * *better* outcome against the health score than a merely completed one.
 */
export const TERMINAL_STATUSES: ComplianceStatus[] = [
  "COMPLETED",
  "SUBMITTED",
  "ACKNOWLEDGED",
]

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as string[]).includes(status)
}

export function isKnownType(type: string): type is ComplianceType {
  // Object.hasOwn, not `in` or a bare index: both walk the prototype chain, so
  // "constructor" or "toString" would resolve to an inherited member instead of
  // undefined and the `??` fallbacks below would never fire.
  return Object.hasOwn(COMPLIANCE_TYPE_GROUP, type)
}

export function groupOf(type: string): ComplianceGroup {
  // Defensive: a row written by an older deploy whose enum value has since been
  // removed should surface as a register row, not crash the dashboard.
  return isKnownType(type) ? COMPLIANCE_TYPE_GROUP[type] : "REGISTER"
}

export function labelOf(type: string): string {
  return isKnownType(type) ? COMPLIANCE_TYPE_LABEL[type] : type
}

export type DashboardRecord = {
  type: string
  status: string
  dueDate: Date | string | null
}

/** An obligation is overdue when it is explicitly OVERDUE, or its deadline has
 *  passed and it has not reached a terminal status. */
export function isOverdue(record: DashboardRecord, now: Date): boolean {
  if (isTerminal(record.status)) return false
  if (record.status === "OVERDUE") return true
  return record.dueDate !== null && new Date(record.dueDate) < now
}

export const OBLIGATION_TYPES = (Object.keys(COMPLIANCE_TYPE_GROUP) as ComplianceType[])
  .filter((t) => COMPLIANCE_TYPE_GROUP[t] === "OBLIGATION")

export const EXCEPTION_TYPES = (Object.keys(COMPLIANCE_TYPE_GROUP) as ComplianceType[])
  .filter((t) => COMPLIANCE_TYPE_GROUP[t] === "EXCEPTION")

export const LEGACY_TYPES = (Object.keys(COMPLIANCE_TYPE_GROUP) as ComplianceType[])
  .filter((t) => COMPLIANCE_TYPE_GROUP[t] === "LEGACY")

/**
 * Prisma predicates for the health summary. Counted in the database rather
 * than by fetching every row: the register groups grow with loan volume, and
 * a summary that loaded all of them to count five numbers is the same
 * unbounded read the records table used to do.
 *
 * Each predicate mirrors one branch of the in-memory rules above, and
 * `record-types.predicates.test.ts` pins the two together.
 */
export const complianceWhere = {
  obligations: (tenantId: string) => ({
    tenantId,
    type: { in: OBLIGATION_TYPES },
  }),
  completeObligations: (tenantId: string) => ({
    tenantId,
    type: { in: OBLIGATION_TYPES },
    status: { in: TERMINAL_STATUSES },
  }),
  overdueObligations: (tenantId: string, now: Date) => ({
    tenantId,
    type: { in: OBLIGATION_TYPES },
    status: { notIn: TERMINAL_STATUSES },
    // `dueDate: { lt: now }` never matches NULL, so a deadline-less record is
    // reached only through the explicit OVERDUE status — exactly as isOverdue.
    OR: [
      { status: "OVERDUE" as const },
      { dueDate: { lt: now } },
    ],
  }),
  openObligationsWithoutDueDate: (tenantId: string) => ({
    tenantId,
    type: { in: OBLIGATION_TYPES },
    status: { notIn: [...TERMINAL_STATUSES, "OVERDUE" as ComplianceStatus] },
    dueDate: null,
  }),
  openExceptions: (tenantId: string) => ({
    tenantId,
    type: { in: EXCEPTION_TYPES },
    status: { notIn: TERMINAL_STATUSES },
  }),
}

export type ComplianceHealth = {
  /** Completed obligations ÷ total obligations, 0–100. */
  score: number
  complete: number
  total: number
  /** Obligations past their deadline. */
  overdue: number
  /**
   * Obligations that are open with NO deadline. These can never become
   * overdue, so a bare "0 overdue — all items on track" is unearned while any
   * of them exist.
   */
  openWithoutDueDate: number
  /** Unresolved EXCEPTION rows, reported separately from the score. */
  openExceptions: number
}

/** Assemble the health summary from counted totals. */
export function buildComplianceHealth(counts: {
  obligations: number
  complete: number
  overdue: number
  openWithoutDueDate: number
  openExceptions: number
}): ComplianceHealth {
  return {
    // An empty obligation register scores 100: there is nothing outstanding.
    // It is not evidence of compliance, which is why the card also shows the
    // denominator rather than the percentage alone.
    score: counts.obligations > 0
      ? Math.round((counts.complete / counts.obligations) * 100)
      : 100,
    complete: counts.complete,
    total: counts.obligations,
    overdue: counts.overdue,
    openWithoutDueDate: counts.openWithoutDueDate,
    openExceptions: counts.openExceptions,
  }
}

/**
 * In-memory equivalent of the predicates above. This is the readable statement
 * of the rules and the reference the predicate tests check themselves against;
 * the dashboard counts in the database.
 */
export function summariseCompliance(
  records: DashboardRecord[],
  now: Date,
): ComplianceHealth {
  const obligations = records.filter((r) => groupOf(r.type) === "OBLIGATION")
  const open = obligations.filter((r) => !isTerminal(r.status))

  // One score formula, shared with the counted path.
  return buildComplianceHealth({
    obligations: obligations.length,
    complete: obligations.filter((r) => isTerminal(r.status)).length,
    overdue: open.filter((r) => isOverdue(r, now)).length,
    openWithoutDueDate: open.filter((r) => r.dueDate === null && r.status !== "OVERDUE").length,
    openExceptions: records.filter(
      (r) => groupOf(r.type) === "EXCEPTION" && !isTerminal(r.status),
    ).length,
  })
}

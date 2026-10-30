import type { UserRole } from "@/lib/permissions"

export const MATRIX_KIND = "APPROVAL_MATRIX"
/** The roles that may approve an application today (the decide route's floor is LOAN_ADMIN). */
export const APPROVER_ROLES = ["LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"] as const satisfies readonly UserRole[]
export type ApproverRole = (typeof APPROVER_ROLES)[number]
export const MAX_LEVELS = 5

export interface MatrixLevel {
  /** 1..n, consecutive. Level 1 approves first. */
  level: number
  name: string
  /** The lowest role that holds this level's authority (by itself, without a delegation). */
  role: ApproverRole
  /** Hours a decision may wait at this level before it escalates to the next. */
  slaHours: number
  /** The credit committee's level: its approval is a recorded committee decision (lib/approval/committee.ts). At most one, and the last. */
  committee: boolean
}

export interface MatrixRuleWhen {
  amountMinCents?: number | null
  amountMaxCents?: number | null
  productIds?: string[]
  branchIds?: string[]
  /** Matches an application graded this rank or worse (0 = best band; lib/decisioning/risk-grade.ts). */
  riskGradeRankMin?: number | null
  /** Matches an application with no risk grade. */
  ungraded?: boolean
}

export interface MatrixRule {
  id: string
  name: string
  when: MatrixRuleWhen
  /** How many levels must approve, in order, by different people. 0: no staff approval chain (the decision engine may approve). */
  requiredLevels: number
}

/** A version of the lender's approval matrix: the whole of what the checker approves. */
export interface MatrixPayload {
  name: string
  /** false: the lender is back on today's single-approver flow. */
  enabled: boolean
  /** SAST calendar day YYYY-MM-DD; a day already past when approved becomes the approval day. */
  effectiveFrom: string
  levels: MatrixLevel[]
  rules: MatrixRule[]
  /** For an application no rule matches. */
  defaultRequiredLevels: number
}

/** What a rule is matched on, read from the application. */
export interface ApplicationFacts {
  amountCents: number
  productId: string
  branchId: string | null
  riskGradeRank: number | null
}

export interface Delegation {
  id: string
  delegatorId: string
  delegateId: string
  level: number
  maxAmountCents: number
  validFrom: Date
  validTo: Date
  revokedAt: Date | null
}

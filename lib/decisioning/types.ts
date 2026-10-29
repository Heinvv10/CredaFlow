import type { DeclineCategory } from "@prisma/client"
import type { FactName } from "./facts"

/**
 * The rule DSL and the scorecard, as stored in DecisionRuleSetVersion.
 * Plain JSON (no code): ./validate.ts is the only way one is accepted.
 */
export type Scalar = string | number | boolean

export const OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "notIn", "isNull", "notNull"] as const
export type Operator = (typeof OPERATORS)[number]

/** `between` takes [low, high] (both inclusive); `in`/`notIn` take a list; isNull/notNull take none. */
export interface Condition {
  field: FactName
  op: Operator
  value?: Scalar | Scalar[]
}

/** Exactly one of `all` (AND) or `any` (OR). */
export interface Group {
  all?: Node[]
  any?: Node[]
}

export type Node = Condition | Group

export const RULE_OUTCOMES = ["KNOCK_OUT", "REFER", "LIMIT_CAP"] as const
export type RuleOutcome = (typeof RULE_OUTCOMES)[number]

export interface RuleDef {
  /** Unique within the set: lower-case letters, digits, hyphen. */
  id: string
  name: string
  outcome: RuleOutcome
  /** UPPER_SNAKE code stored with every decision this rule drives. */
  reasonCode: string
  /** KNOCK_OUT only: the category the client's decline reason comes from. */
  declineCategory?: DeclineCategory
  /** LIMIT_CAP only: the largest principal (cents) the rule allows when it fires. */
  limitCapCents?: number
  when: Node
}

/** Numeric: min inclusive, max exclusive. Otherwise `equals` or `in`. */
export interface ScorecardBin {
  min?: number
  max?: number
  equals?: Scalar
  in?: Scalar[]
  points: number
}

export interface Characteristic {
  field: FactName
  bins: ScorecardBin[]
  /** Points when the fact is missing or matches no bin. */
  missingPoints: number
}

export const BAND_ACTIONS = ["ALLOW", "REFER", "DECLINE"] as const
export type BandAction = (typeof BAND_ACTIONS)[number]

/** A band applies from `minScore` up to the next band's. The lowest band catches everything below. */
export interface GradeBand {
  minScore: number
  /** 1-4 characters of A-Z, 0-9, + or -. */
  grade: string
  action: BandAction
  /** Opaque label the product engine (A5) prices by. */
  pricingTier?: string
  /** DECLINE only; POLICY when absent. */
  declineCategory?: DeclineCategory
}

export interface Scorecard {
  baseScore: number
  characteristics: Characteristic[]
  /** Strictly descending by minScore. */
  bands: GradeBand[]
}

export interface RuleHit {
  ruleId: string
  name: string
  outcome: RuleOutcome
  reasonCode: string
  declineCategory?: DeclineCategory
  limitCapCents?: number
}

export interface ScoreResult {
  score: number
  grade: string
  action: BandAction
  pricingTier: string | null
  declineCategory: DeclineCategory | null
  /** Points per characteristic, for the explanation shown to staff. */
  breakdown: { field: FactName; points: number }[]
}

export type DecisionKind = "APPROVE" | "DECLINE" | "REFER"

export interface Verdict {
  decision: DecisionKind
  /** Never empty. */
  reasonCodes: string[]
  declineCategory: DeclineCategory | null
  riskGrade: string | null
  score: number | null
  pricingTier: string | null
  limitCapCents: number | null
  hits: RuleHit[]
}

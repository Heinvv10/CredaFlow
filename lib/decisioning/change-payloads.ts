import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import { CHANNELS } from "./facts"
import { Problems, isObject, rejectUnknownKeys } from "./validate-common"
import { parseRules } from "./validate-rules"
import { parseScorecard } from "./validate-scorecard"
import type { RuleDef, Scorecard } from "./types"

export const RULE_SET_KIND = "DECISION_RULE_SET"
export const ENGINE_CONFIG_KIND = "DECISION_ENGINE_CONFIG"

/** A new rule set version: the whole of what the checker approves. The version number is assigned on approval. */
export interface RuleSetPayload {
  /** A product id, or null for every product without a set of its own. */
  productId: string | null
  name: string
  /** SAST calendar day YYYY-MM-DD; a day already past when approved becomes the approval day. */
  effectiveFrom: string
  /** Runs only as the lender's challenger, never as champion. */
  challengerOnly: boolean
  rules: RuleDef[]
  scorecard: Scorecard | null
}

export interface EngineConfigPayload {
  mode: "OFF" | "SHADOW" | "LIVE"
  channels: string[]
  productIds: string[]
  repaymentMethod: "EFT" | "DEBIT_ORDER"
  challengerVersionId: string | null
  challengerPercent: number
  /** The lender's legal sign-off of automated declines (POPIA s71); needs the notice. Until set, a LIVE engine never declines. */
  s71SignOff: boolean
  /** The paragraph the client's decline message carries for an automated decision, as the lender's legal team approved it. */
  automatedDeclineNotice: string | null
}

/** Draft or placeholder wording must never be approvable as the lender's notice. */
const PLACEHOLDER_NOTICE = /\b(draft|todo|tbc|lorem)\b/i
export const NOTICE_MIN_LENGTH = 20
export const NOTICE_MAX_LENGTH = 2000

const isDay = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v)
}

export function parseRuleSetPayload(raw: unknown): RuleSetPayload {
  if (!isObject(raw)) throw new InvalidPayloadError(["payload: expected an object"])
  const problems = new Problems()
  rejectUnknownKeys(raw, ["productId", "name", "effectiveFrom", "challengerOnly", "rules", "scorecard"], "payload", problems)
  if (raw.productId !== null && (typeof raw.productId !== "string" || raw.productId.length === 0)) problems.add("payload.productId", "a product id, or null for all products")
  if (typeof raw.name !== "string" || raw.name !== raw.name.trim() || raw.name.length < 1 || raw.name.length > 100) problems.add("payload.name", "1 to 100 characters, no surrounding spaces")
  if (!isDay(raw.effectiveFrom)) problems.add("payload.effectiveFrom", "a date, YYYY-MM-DD")
  if (typeof raw.challengerOnly !== "boolean") problems.add("payload.challengerOnly", "true or false")
  problems.throwIfAny()
  const rules = parseRules(raw.rules)
  const scorecard = parseScorecard(raw.scorecard ?? null)
  if (rules.length === 0 && scorecard === null) throw new InvalidPayloadError(["payload: a rule set needs at least one rule or a scorecard"])
  return {
    productId: raw.productId as string | null,
    name: raw.name as string,
    effectiveFrom: raw.effectiveFrom as string,
    challengerOnly: raw.challengerOnly as boolean,
    rules,
    scorecard,
  }
}

export function parseEngineConfigPayload(raw: unknown): EngineConfigPayload {
  if (!isObject(raw)) throw new InvalidPayloadError(["payload: expected an object"])
  const problems = new Problems()
  rejectUnknownKeys(raw, ["mode", "channels", "productIds", "repaymentMethod", "challengerVersionId", "challengerPercent", "s71SignOff", "automatedDeclineNotice"], "payload", problems)
  if (raw.mode !== "OFF" && raw.mode !== "SHADOW" && raw.mode !== "LIVE") problems.add("payload.mode", "OFF, SHADOW or LIVE")
  const list = (value: unknown, path: string, allowed?: readonly string[]) => {
    if (!Array.isArray(value) || value.length > 100 || value.some((v) => typeof v !== "string" || v.length === 0) || new Set(value).size !== value.length) {
      problems.add(path, "a list of distinct values")
    } else if (allowed && value.some((v) => !allowed.includes(v))) {
      problems.add(path, `values from ${allowed.join(", ")}`)
    }
  }
  list(raw.channels, "payload.channels", CHANNELS)
  list(raw.productIds, "payload.productIds")
  if (raw.repaymentMethod !== "EFT" && raw.repaymentMethod !== "DEBIT_ORDER") problems.add("payload.repaymentMethod", "EFT or DEBIT_ORDER")
  if (raw.challengerVersionId !== null && (typeof raw.challengerVersionId !== "string" || raw.challengerVersionId.length === 0)) problems.add("payload.challengerVersionId", "a rule set version id, or null")
  if (typeof raw.challengerPercent !== "number" || !Number.isInteger(raw.challengerPercent) || raw.challengerPercent < 0 || raw.challengerPercent > 50) problems.add("payload.challengerPercent", "a whole number from 0 to 50")
  if (typeof raw.s71SignOff !== "boolean") problems.add("payload.s71SignOff", "true or false")
  const notice = raw.automatedDeclineNotice
  if (notice !== null && (typeof notice !== "string" || notice !== notice.trim() || notice.length < NOTICE_MIN_LENGTH || notice.length > NOTICE_MAX_LENGTH)) {
    problems.add("payload.automatedDeclineNotice", `null, or ${NOTICE_MIN_LENGTH} to ${NOTICE_MAX_LENGTH} characters with no surrounding spaces`)
  } else if (typeof notice === "string" && PLACEHOLDER_NOTICE.test(notice)) {
    problems.add("payload.automatedDeclineNotice", "placeholder wording (draft, TODO, TBC) cannot be approved as the client notice")
  }
  problems.throwIfAny()
  const payload = raw as unknown as EngineConfigPayload
  if (payload.s71SignOff && payload.automatedDeclineNotice === null) problems.add("payload.s71SignOff", "the sign-off covers the client notice: provide the approved wording")
  if (payload.mode !== "OFF" && (payload.channels.length === 0 || payload.productIds.length === 0)) problems.add("payload", "choose at least one channel and one product, or switch the engine off")
  if (payload.challengerPercent > 0 && !payload.challengerVersionId) problems.add("payload.challengerVersionId", "name the challenger version to send applications to")
  problems.throwIfAny()
  return payload
}

/**
 * Pricing rules (spec 2.1.4): by customer segment, risk grade, channel and promotional campaign. A rule names the
 * conditions it needs (every condition it does not name matches anything) and the price it sets. One rule prices an
 * application: the most specific that matches (most conditions named), then the higher priority, then the newer rule,
 * then the lower id: rules never stack. Pure; the rules come from the database (resolve.ts) and every rule is a change a
 * second person approved (change-handlers.ts).
 *
 * The risk grade is read by RANK, never by label (lib/decisioning/risk-grade.ts): 0 is the best band of the scorecard
 * that graded the application. An application with no grade matches no rule that names one.
 */
import { PRICING_CHANNELS, isPricingChannel } from "./channels"
import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import { Problems, isObject, rejectUnknownKeys } from "@/lib/decisioning/validate-common"

export interface PricingRule {
  id: string
  /** A product id, or null for every product. */
  productId: string | null
  name: string
  segment: string | null
  channel: string | null
  /** Both set or both null: the grade ranks the rule covers, inclusive. */
  riskRankMin: number | null
  riskRankMax: number | null
  campaignCode: string | null
  /** SAST days, inclusive. */
  validFrom: string
  validTo: string | null
  priority: number
  /** SET replaces the product's monthly rate; ADD moves it (a negative value is a discount), never below 0. */
  rate: { mode: "SET" | "ADD"; value: number }
  /** A replacement for the product's initiation fee share, or null. The statutory ceiling still applies on top. */
  initiationFeePct: number | null
  createdAt: string
}

export interface PricingContext {
  productId: string
  segment: string | null
  channel: string | null
  /** The application's risk grade rank (0 = best), or null when it has no grade. */
  riskRank: number | null
  campaignCode: string | null
  /** SAST day the price is for. */
  asOf: string
}

export interface ResolvedPricing {
  ratePm: number
  initiationFeePct: number
  ruleId: string | null
  ruleName: string | null
}

function conditions(rule: PricingRule): number {
  return [rule.productId, rule.segment, rule.channel, rule.riskRankMin, rule.campaignCode].filter((c) => c !== null).length
}

function matches(rule: PricingRule, ctx: PricingContext): boolean {
  if (rule.validFrom > ctx.asOf || (rule.validTo !== null && rule.validTo < ctx.asOf)) return false
  if (rule.productId !== null && rule.productId !== ctx.productId) return false
  if (rule.segment !== null && rule.segment !== ctx.segment) return false
  if (rule.channel !== null && rule.channel !== ctx.channel) return false
  if (rule.campaignCode !== null && rule.campaignCode !== ctx.campaignCode) return false
  if (rule.riskRankMin !== null) {
    if (ctx.riskRank === null) return false
    if (ctx.riskRank < rule.riskRankMin || ctx.riskRank > (rule.riskRankMax ?? rule.riskRankMin)) return false
  }
  return true
}

export function resolvePricing(rules: readonly PricingRule[], ctx: PricingContext, base: { ratePm: number; initiationFeePct: number }): ResolvedPricing {
  const winner = rules
    .filter((r) => matches(r, ctx))
    .sort((a, b) => conditions(b) - conditions(a) || b.priority - a.priority || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))[0]
  if (!winner) return { ratePm: base.ratePm, initiationFeePct: base.initiationFeePct, ruleId: null, ruleName: null }
  const ratePm = winner.rate.mode === "SET" ? winner.rate.value : Math.max(0, base.ratePm + winner.rate.value)
  return { ratePm, initiationFeePct: winner.initiationFeePct ?? base.initiationFeePct, ruleId: winner.id, ruleName: winner.name }
}

export const PRICING_RULE_KIND = "PRODUCT_PRICING_RULE"

export type PricingRulePayload =
  | { action: "CREATE"; rule: Omit<PricingRule, "id" | "createdAt"> }
  | { action: "RETIRE"; ruleId: string }

const isDay = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v)
}

const label = (path: string, v: unknown, problems: Problems): string | null => {
  if (v === null) return null
  if (typeof v !== "string" || v.length < 1 || v.length > 60 || v !== v.trim()) {
    problems.add(path, "1 to 60 characters, no surrounding spaces, or null for any")
    return null
  }
  return v
}

export function parsePricingRule(raw: unknown): PricingRulePayload {
  if (!isObject(raw)) throw new InvalidPayloadError(["payload: expected an object"])
  const problems = new Problems()
  if (raw.action === "RETIRE") {
    rejectUnknownKeys(raw, ["action", "ruleId"], "payload", problems)
    if (typeof raw.ruleId !== "string" || raw.ruleId.length === 0) problems.add("ruleId", "the id of the rule to retire")
    problems.throwIfAny()
    return { action: "RETIRE", ruleId: raw.ruleId as string }
  }
  if (raw.action !== "CREATE") throw new InvalidPayloadError(["action: CREATE or RETIRE"])
  rejectUnknownKeys(raw, ["action", "rule"], "payload", problems)
  const r = raw.rule
  if (!isObject(r)) {
    problems.add("rule", "an object")
    problems.throwIfAny()
  }
  const rule = r as Record<string, unknown>
  rejectUnknownKeys(rule, ["productId", "name", "segment", "channel", "riskRankMin", "riskRankMax", "campaignCode", "validFrom", "validTo", "priority", "rate", "initiationFeePct"], "rule", problems)
  if (rule.productId !== null && (typeof rule.productId !== "string" || rule.productId.length === 0)) problems.add("rule.productId", "a product id, or null for every product")
  if (typeof rule.name !== "string" || rule.name !== rule.name.trim() || rule.name.length < 1 || rule.name.length > 100) problems.add("rule.name", "1 to 100 characters, no surrounding spaces")
  const segment = label("rule.segment", rule.segment ?? null, problems)
  const channel = label("rule.channel", rule.channel ?? null, problems)
  if (channel !== null && !isPricingChannel(channel)) problems.add("rule.channel", `one of ${PRICING_CHANNELS.join(", ")} (the channel is set by the system, not typed)`)
  const rankOk = (v: unknown) => v === null || v === undefined || (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 50)
  if (!rankOk(rule.riskRankMin) || !rankOk(rule.riskRankMax)) problems.add("rule.riskRankMin", "a whole grade rank from 0 (best) to 50, or null")
  else if ((rule.riskRankMin ?? null) === null !== ((rule.riskRankMax ?? null) === null)) problems.add("rule.riskRankMin", "give both ends of the rank range, or neither")
  else if (rule.riskRankMin != null && rule.riskRankMax != null && (rule.riskRankMax as number) < (rule.riskRankMin as number)) problems.add("rule.riskRankMin", "the first rank must not be after the last")
  if (rule.campaignCode !== null && rule.campaignCode !== undefined && (typeof rule.campaignCode !== "string" || !/^[A-Z][A-Z0-9_]{1,39}$/.test(rule.campaignCode))) problems.add("rule.campaignCode", "UPPER_SNAKE, 2 to 40 characters, or null")
  if (!isDay(rule.validFrom)) problems.add("rule.validFrom", "a date, YYYY-MM-DD")
  if (rule.validTo !== null && rule.validTo !== undefined && !isDay(rule.validTo)) problems.add("rule.validTo", "a date, YYYY-MM-DD, or null")
  else if (typeof rule.validTo === "string" && isDay(rule.validFrom) && rule.validTo < rule.validFrom) problems.add("rule.validTo", "not before the start date")
  if (typeof rule.priority !== "number" || !Number.isInteger(rule.priority) || rule.priority < 0 || rule.priority > 1000) problems.add("rule.priority", "a whole number from 0 to 1000")
  const rate = rule.rate
  if (!isObject(rate) || (rate.mode !== "SET" && rate.mode !== "ADD") || typeof rate.value !== "number" || !Number.isFinite(rate.value)
    || (rate.mode === "SET" ? rate.value < 0 || rate.value >= 1 : rate.value <= -1 || rate.value >= 1)) {
    problems.add("rule.rate", "{ mode: SET (a monthly rate from 0 up to 1) | ADD (a monthly change between -1 and 1), value }")
  }
  if (rule.initiationFeePct !== null && rule.initiationFeePct !== undefined && (typeof rule.initiationFeePct !== "number" || rule.initiationFeePct < 0 || rule.initiationFeePct > 1)) problems.add("rule.initiationFeePct", "a share of the principal from 0 to 1, or null")
  problems.throwIfAny()
  return {
    action: "CREATE",
    rule: {
      productId: (rule.productId as string | null) ?? null, name: rule.name as string, segment, channel,
      riskRankMin: (rule.riskRankMin as number | null | undefined) ?? null, riskRankMax: (rule.riskRankMax as number | null | undefined) ?? null,
      campaignCode: (rule.campaignCode as string | null | undefined) ?? null, validFrom: rule.validFrom as string, validTo: (rule.validTo as string | null | undefined) ?? null,
      priority: rule.priority as number, rate: { mode: (rate as { mode: "SET" | "ADD" }).mode, value: (rate as { value: number }).value },
      initiationFeePct: (rule.initiationFeePct as number | null | undefined) ?? null,
    },
  }
}

import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import {
  DECLINE_CATEGORY_HINT, Problems, checkScalar, factDefinition, isDeclineCategory, isObject, rejectUnknownKeys,
} from "./validate-common"
import { RESERVED_REASON_CODES } from "./decide"
import { OPERATORS, RULE_OUTCOMES, type Node, type Operator, type RuleDef } from "./types"

const MAX_RULES = 100
const MAX_DEPTH = 5
const MAX_NODES = 100
const MAX_GROUP = 20
const MAX_LIST = 50

const OPERATORS_BY_TYPE = {
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "notIn", "isNull", "notNull"],
  string: ["eq", "neq", "in", "notIn", "isNull", "notNull"],
  boolean: ["eq", "neq"],
} as const

function checkCondition(raw: Record<string, unknown>, path: string, problems: Problems): void {
  rejectUnknownKeys(raw, ["field", "op", "value"], path, problems)
  const fact = factDefinition(raw.field, `${path}.field`, problems)
  if (!fact) return
  const op = raw.op as Operator
  if (!(OPERATORS as readonly string[]).includes(op) || !(OPERATORS_BY_TYPE[fact.def.type] as readonly string[]).includes(op)) {
    problems.add(`${path}.op`, `operator "${String(raw.op)}" does not apply to ${fact.def.label} (a ${fact.def.type})`)
    return
  }
  const valuePath = `${path}.value`
  if (op === "isNull" || op === "notNull") {
    if (raw.value !== undefined) problems.add(valuePath, `${op} takes no value`)
  } else if (op === "between") {
    const pair = raw.value
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((n) => typeof n === "number" && Number.isFinite(n))) {
      problems.add(valuePath, "between takes two numbers [low, high]")
    } else if (pair[0] > pair[1]) {
      problems.add(valuePath, "between needs low not above high")
    }
  } else if (op === "in" || op === "notIn") {
    const list = raw.value
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_LIST) {
      problems.add(valuePath, `${op} takes a list of 1 to ${MAX_LIST} values`)
    } else {
      list.forEach((item, i) => checkScalar(item, fact.def, `${valuePath}[${i}]`, problems))
    }
  } else {
    checkScalar(raw.value, fact.def, valuePath, problems)
  }
}

function checkNode(raw: unknown, path: string, depth: number, budget: { nodes: number }, problems: Problems): void {
  if (!isObject(raw)) return problems.add(path, "expected a condition or a group")
  if (++budget.nodes > MAX_NODES) return problems.add(path, `a rule has at most ${MAX_NODES} conditions and groups`)
  if ("field" in raw) return checkCondition(raw, path, problems)
  const keys = ["all", "any"].filter((k) => k in raw)
  rejectUnknownKeys(raw, ["all", "any"], path, problems)
  if (keys.length !== 1) return problems.add(path, 'a group has exactly one of "all" or "any"')
  if (depth >= MAX_DEPTH) return problems.add(path, `groups are nested more than ${MAX_DEPTH} deep`)
  const children = raw[keys[0]]
  if (!Array.isArray(children) || children.length === 0 || children.length > MAX_GROUP) {
    return problems.add(`${path}.${keys[0]}`, `a group holds at least one and at most ${MAX_GROUP} entries`)
  }
  children.forEach((child, i) => checkNode(child, `${path}.${keys[0]}[${i}]`, depth + 1, budget, problems))
}

function checkRule(raw: unknown, path: string, seen: Set<string>, problems: Problems): void {
  if (!isObject(raw)) return problems.add(path, "expected an object")
  rejectUnknownKeys(raw, ["id", "name", "outcome", "reasonCode", "declineCategory", "limitCapCents", "when"], path, problems)
  if (typeof raw.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(raw.id)) {
    problems.add(`${path}.id`, "lower-case letters, digits and hyphens, up to 40")
  } else if (seen.has(raw.id)) {
    problems.add(`${path}.id`, `duplicate rule id "${raw.id}"`)
  } else {
    seen.add(raw.id)
  }
  if (typeof raw.name !== "string" || raw.name !== raw.name.trim() || raw.name.length < 1 || raw.name.length > 100) {
    problems.add(`${path}.name`, "1 to 100 characters, no surrounding spaces")
  }
  if (!(RULE_OUTCOMES as readonly unknown[]).includes(raw.outcome)) {
    problems.add(`${path}.outcome`, `one of ${RULE_OUTCOMES.join(", ")}`)
  }
  if (typeof raw.reasonCode !== "string" || !/^[A-Z][A-Z0-9_]{2,39}$/.test(raw.reasonCode)) {
    problems.add(`${path}.reasonCode`, "UPPER_SNAKE_CASE, 3 to 40 characters")
  } else if (RESERVED_REASON_CODES.some((code) => raw.reasonCode === code || (code.endsWith("_") && (raw.reasonCode as string).startsWith(code)))) {
    problems.add(`${path}.reasonCode`, `"${raw.reasonCode}" is reserved by the engine`)
  }
  if (raw.outcome === "KNOCK_OUT" && !isDeclineCategory(raw.declineCategory)) {
    problems.add(`${path}.declineCategory`, `a knock-out needs ${DECLINE_CATEGORY_HINT}`)
  }
  if (raw.outcome !== "KNOCK_OUT" && raw.declineCategory !== undefined) {
    problems.add(`${path}.declineCategory`, "only a knock-out takes a declineCategory")
  }
  const capOk = typeof raw.limitCapCents === "number" && Number.isInteger(raw.limitCapCents) && raw.limitCapCents >= 0 && raw.limitCapCents <= 100_000_000_000
  if (raw.outcome === "LIMIT_CAP" && !capOk) problems.add(`${path}.limitCapCents`, "a limit cap needs a whole number of cents, 0 or more")
  if (raw.outcome !== "LIMIT_CAP" && raw.limitCapCents !== undefined) problems.add(`${path}.limitCapCents`, "only a limit cap takes limitCapCents")
  checkNode(raw.when, `${path}.when`, 0, { nodes: 0 }, problems)
}

/** Validates untrusted JSON as a rule list. Returns it as stored; throws InvalidPayloadError listing every problem. */
export function parseRules(raw: unknown): RuleDef[] {
  const problems = new Problems()
  if (!Array.isArray(raw)) throw new InvalidPayloadError(["rules: expected an array"])
  if (raw.length > MAX_RULES) problems.add("rules", `at most ${MAX_RULES} rules`)
  const seen = new Set<string>()
  raw.forEach((rule, i) => checkRule(rule, `rules[${i}]`, seen, problems))
  problems.throwIfAny()
  return raw as RuleDef[]
}

export type { Node }

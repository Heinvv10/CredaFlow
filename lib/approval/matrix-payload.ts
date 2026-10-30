import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import { Problems, isObject, rejectUnknownKeys } from "@/lib/decisioning/validate-common"
import { APPROVER_ROLES, MAX_LEVELS, type ApproverRole, type MatrixLevel, type MatrixPayload, type MatrixRule, type MatrixRuleWhen } from "./types"

const DAY = /^\d{4}-\d{2}-\d{2}$/
const RULE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/
const MAX_SLA_HOURS = 720
const MAX_RULES = 100
const MAX_LIST = 50

const isCents = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 2_147_483_647
const isCount = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max
const ids = (v: unknown): v is string[] => Array.isArray(v) && v.length <= MAX_LIST && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 64) && new Set(v).size === v.length

function parseLevels(raw: unknown, problems: Problems): MatrixLevel[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_LEVELS) {
    problems.add("payload.levels", `between 1 and ${MAX_LEVELS} levels`)
    return []
  }
  const levels: MatrixLevel[] = []
  raw.forEach((entry, i) => {
    const path = `payload.levels[${i}]`
    if (!isObject(entry)) return problems.add(path, "expected an object")
    rejectUnknownKeys(entry, ["level", "name", "role", "slaHours", "committee"], path, problems)
    if (entry.level !== i + 1) problems.add(path, `levels must be consecutive from 1 (expected level ${i + 1})`)
    if (typeof entry.name !== "string" || entry.name.trim() !== entry.name || entry.name.length < 1 || entry.name.length > 60) problems.add(`${path}.name`, "1 to 60 characters, no surrounding spaces")
    if (!(APPROVER_ROLES as readonly string[]).includes(entry.role as string)) problems.add(`${path}.role`, `a role that may approve: ${APPROVER_ROLES.join(", ")}`)
    if (!isCount(entry.slaHours, MAX_SLA_HOURS) || entry.slaHours < 1) problems.add(`${path}.slaHours`, `a whole number of hours from 1 to ${MAX_SLA_HOURS}`)
    if (typeof entry.committee !== "boolean") problems.add(`${path}.committee`, "true or false")
    levels.push(entry as unknown as MatrixLevel)
  })
  const rank = (role: ApproverRole) => APPROVER_ROLES.indexOf(role)
  levels.forEach((level, i) => {
    if (i > 0 && (APPROVER_ROLES as readonly string[]).includes(level.role) && rank(level.role) < rank(levels[i - 1].role)) {
      problems.add(`payload.levels[${i}].role`, "not lower than the role of the level before it")
    }
  })
  const committees = levels.filter((l) => l.committee)
  if (committees.length > 1 || (committees.length === 1 && committees[0].level !== levels.length)) {
    problems.add("payload.levels", "the committee flag is for one level, the last")
  }
  return levels
}

function parseWhen(raw: unknown, path: string, problems: Problems): MatrixRuleWhen {
  if (!isObject(raw)) {
    problems.add(path, "expected an object")
    return {}
  }
  rejectUnknownKeys(raw, ["amountMinCents", "amountMaxCents", "productIds", "branchIds", "riskGradeRankMin", "ungraded"], path, problems)
  for (const key of ["amountMinCents", "amountMaxCents"] as const) {
    if (raw[key] != null && !isCents(raw[key])) problems.add(`${path}.${key}`, "a whole, non-negative amount in cents")
  }
  if (isCents(raw.amountMinCents) && isCents(raw.amountMaxCents) && raw.amountMinCents > raw.amountMaxCents) problems.add(`${path}.amountMinCents`, "must not exceed amountMaxCents")
  for (const key of ["productIds", "branchIds"] as const) {
    if (raw[key] !== undefined && !ids(raw[key])) problems.add(`${path}.${key}`, `a list of up to ${MAX_LIST} distinct ids`)
  }
  if (raw.riskGradeRankMin != null && !isCount(raw.riskGradeRankMin, 99)) problems.add(`${path}.riskGradeRankMin`, "a whole number from 0 to 99")
  if (raw.ungraded !== undefined && typeof raw.ungraded !== "boolean") problems.add(`${path}.ungraded`, "true or false")
  return raw as MatrixRuleWhen
}

function parseRules(raw: unknown, levelCount: number, problems: Problems): MatrixRule[] {
  if (!Array.isArray(raw) || raw.length > MAX_RULES) {
    problems.add("payload.rules", `a list of up to ${MAX_RULES} rules`)
    return []
  }
  const seen = new Set<string>()
  const rules: MatrixRule[] = []
  raw.forEach((entry, i) => {
    const path = `payload.rules[${i}]`
    if (!isObject(entry)) return problems.add(path, "expected an object")
    rejectUnknownKeys(entry, ["id", "name", "when", "requiredLevels"], path, problems)
    if (typeof entry.id !== "string" || !RULE_ID.test(entry.id)) problems.add(`${path}.id`, "lower-case letters, digits, - and _, up to 40 characters")
    else if (seen.has(entry.id)) problems.add(`${path}.id`, `repeated rule id "${entry.id}"`)
    else seen.add(entry.id)
    if (typeof entry.name !== "string" || entry.name.trim() !== entry.name || entry.name.length < 1 || entry.name.length > 80) problems.add(`${path}.name`, "1 to 80 characters, no surrounding spaces")
    if (!isCount(entry.requiredLevels, levelCount)) problems.add(`${path}.requiredLevels`, `a whole number from 0 to ${levelCount} (the number of levels)`)
    rules.push({ ...(entry as unknown as MatrixRule), when: parseWhen(entry.when, `${path}.when`, problems) })
  })
  return rules
}

/** Validates untrusted JSON into the matrix a checker approves. Pure; the database checks (products, branches) are in the handler's verify. */
export function parseMatrixPayload(raw: unknown): MatrixPayload {
  const problems = new Problems()
  if (!isObject(raw)) throw new InvalidPayloadError(["payload: expected an object"])
  rejectUnknownKeys(raw, ["name", "enabled", "effectiveFrom", "levels", "rules", "defaultRequiredLevels"], "payload", problems)
  if (typeof raw.name !== "string" || raw.name.trim() !== raw.name || raw.name.length < 1 || raw.name.length > 80) problems.add("payload.name", "1 to 80 characters, no surrounding spaces")
  if (typeof raw.enabled !== "boolean") problems.add("payload.enabled", "true or false")
  if (typeof raw.effectiveFrom !== "string" || !DAY.test(raw.effectiveFrom) || Number.isNaN(Date.parse(`${raw.effectiveFrom}T00:00:00Z`))) problems.add("payload.effectiveFrom", "a day, YYYY-MM-DD")
  const levels = parseLevels(raw.levels, problems)
  const rules = parseRules(raw.rules, levels.length, problems)
  if (!isCount(raw.defaultRequiredLevels, levels.length)) problems.add("payload.defaultRequiredLevels", `a whole number from 0 to ${levels.length} (the number of levels)`)
  problems.throwIfAny()
  return { name: raw.name as string, enabled: raw.enabled as boolean, effectiveFrom: raw.effectiveFrom as string, levels, rules, defaultRequiredLevels: raw.defaultRequiredLevels as number }
}

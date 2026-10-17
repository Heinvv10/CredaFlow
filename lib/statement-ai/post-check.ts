/**
 * The post-check every model output passes before an officer may see it
 * (goal 2026-10-17 §2a.3, §2a.4). The model never does arithmetic: every
 * figure in its text must be a figure it was given (a fact, or a query result
 * in the same run), copied exactly as it was written to it ("R1 234.56",
 * "-R450.00", "12.5%", "2026-09-25", "2026-09", "3").
 *
 * It is an allowlist, not a reader of figures: each given figure is removed
 * where it stands as a whole token, and then any digit left, any figure in
 * words that is not a given count, any month or weekday name, ordinal,
 * fraction, scale or quantity word rejects the output. A figure written any
 * other way ("R1 234,56", "R1.2k", "twenty-one", "the 5th", "½") is never
 * read, so it is never read wrongly. Fail closed: a rejected output costs a
 * retry; a wrong figure shown costs a credit decision.
 *
 * Deterministic, never calls the model. The language checks (reassurance,
 * verdicts, flag explanations) are in post-check-language.ts.
 */
import { checkFigures } from "./post-check-figures"
import { checkFlagExplanation, checkLanguage, type FlagSpec } from "./post-check-language"
import { fail, OK, type Allowed, type CheckResult } from "./post-check-core"

export { checkFigures } from "./post-check-figures"
export { checkFlagExplanation, checkNoContradiction, type Direction, type FlagSpec } from "./post-check-language"
export { fail, norm, OK, stripLiterals, type Allowed, type CheckResult } from "./post-check-core"

export interface PostCheckInput {
  text: string
  allowed: Allowed
  raisedFlagCodes: readonly string[]
  /** FLAG_EXPLANATION only. */
  flag?: FlagSpec
}

export const MAX_OUTPUT_CHARS = 4000

/** Every check, in order; the first failure is the reason stored on the REJECTED row. */
export function postCheck(input: PostCheckInput): CheckResult {
  if (!input.text.trim()) return fail("empty output")
  if (input.text.length > MAX_OUTPUT_CHARS) return fail("output too long")
  const literals = [...(input.allowed.literals ?? []), ...input.raisedFlagCodes, ...(input.flag ? [input.flag.code] : [])]
  const figures = checkFigures(input.text, { ...input.allowed, literals })
  if (!figures.ok) return figures
  const language = checkLanguage(input.text, input.raisedFlagCodes, [...(input.allowed.names ?? []), ...(input.flag ? [input.flag.code] : [])], input.allowed.payees ?? [])
  if (!language.ok) return language
  return input.flag ? checkFlagExplanation(input.text, input.flag) : OK
}

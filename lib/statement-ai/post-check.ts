/**
 * The post-check every model output passes before an officer may see it
 * (goal 2026-10-17 §2a.3, §2a.4). The model never does arithmetic: every
 * amount, percentage, count and date in its text must equal a figure it was
 * given (a fact, or a query result in the same run). Anything else, or any
 * figure written in a form this check cannot read exactly ("R1.2k", "about
 * twelve hundred", "12/09"), rejects the whole output. Fail closed: a
 * rejected output costs a retry; a wrong figure shown costs a credit decision.
 *
 * It is deterministic and never calls the model. The rules' flags stay the
 * decision: an output that calls anything acceptable, normal or resolved
 * while a flag is raised is rejected, and so is any output that recommends a
 * decision or gives its own verdict on a document's authenticity.
 */

export interface Allowed {
  /** Amounts in cents (sign ignored: "overdrawn by R500" is -50000 written as a size). */
  amountsCents: Iterable<number>
  /** The amounts that are a month's figure: only these may be called monthly ("R500.00 a month"). */
  monthlyAmountsCents?: Iterable<number>
  /** Percentages as written, e.g. 12.5 for "12.5%". */
  percents?: Iterable<number>
  /** Plain numbers: counts, days, years. */
  numbers?: Iterable<number>
  /** YYYY-MM-DD */
  dates?: Iterable<string>
  /** YYYY-MM */
  months?: Iterable<string>
  /** Text copied from the input that may contain digits (masked keys such as "CASHSEND 999", flag codes). */
  literals?: Iterable<string>
}

export type CheckResult = { ok: true } | { ok: false; reason: string }

const OK: CheckResult = { ok: true }
const fail = (reason: string): CheckResult => ({ ok: false, reason })

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
const MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

/** A month name: full names in any case except "may" and "march" (verbs), which count capitalised; abbreviations capitalised. */
function monthIndex(word: string): number | null {
  const lower = word.toLowerCase()
  const full = MONTHS.indexOf(lower)
  if (full >= 0) {
    if ((lower === "may" || lower === "march") && word[0] !== word[0].toUpperCase()) return null
    return full
  }
  const abbr = MONTH_ABBR.indexOf(lower.replace(/\.$/, "").replace(/^sept$/, "sep"))
  if (abbr >= 0 && word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()) return abbr
  return null
}

const MONTH_WORD = "(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\\.?"

/** Cardinal and fraction words: a figure in words must be a figure the model was given, and fractions never are. */
const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}
/** Words that scale or divide a figure: never exact, always rejected. */
const SCALE_WORDS = /\b(hundreds?|thousands?|millions?|billions?|trillions?|half|halves|quarters?|thirds|dozens?|twice|thrice|double[sd]?|tripled?|quadrupled?|couple of|tens of|percentage points?)\b/i
const RELATIVE_DATES = /\b(yesterday|today|tomorrow|(last|next|this|previous|coming) (week|month|year|quarter)|\d+ (days?|weeks?|months?|years?) ago|ago)\b/i
const ABBREVIATED = /\d\s*(k|m|bn|mn|mil|thousand|million|billion)\b/i

/** Words after an amount that make it a month's figure. */
const MONTHLY = /^[^.;:!?]{0,12}?\b(monthly|per month|a month|each month|every month|p\.?m\.?)(\b|$)/i

/** "one" as a pronoun ("no one", "matched to one.", "one of"), not a count. */
function isPronoun(before: string | undefined, after: string | undefined): boolean {
  return ["no", "the", "this", "that", "each", "any", "every", "which", "to", "a", "another"].includes(before ?? "") ||
    after === undefined || /^[.,;:!?]$/.test(after) || ["of", "another", "or"].includes(after)
}

/** Every ISO date in text, removed as checked. */
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g
const ISO_MONTH = /\b(\d{4})-(\d{2})\b/g
const SLASH_DATE = /\b\d{1,4}\/\d{1,2}(\/\d{1,4})?\b/
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_WORD})(?:,?\\s+(\\d{4}))?\\b`, "gi")
const MONTH_DAY = new RegExp(`\\b(${MONTH_WORD})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "gi")
const MONTH_YEAR = new RegExp(`\\b(${MONTH_WORD})\\s+(\\d{4})\\b`, "gi")

/**
 * A figure: an optional currency, digits grouped by a space, a non-breaking
 * space or a comma in threes, an optional decimal part, and an optional unit.
 */
const FIGURE = /(?<![\w.])(-|−)?\s?(R|ZAR)?\s?(-|−)?(\d{1,3}(?:[  ,]\d{3})+|\d+)(\.\d+)?(?!\d)(\s?(?:%|percent\b|per cent\b|rand\b|c\b|cents\b))?/gi

function norm(text: string): string {
  // Full-width and other compatibility digits become ASCII; thin and narrow spaces become spaces.
  return text.normalize("NFKC").replace(/[   ]/g, " ")
}

function strip(text: string, literals: Iterable<string>): string {
  let out = text
  for (const lit of [...literals].filter((l) => l.length > 0).sort((a, b) => b.length - a.length)) {
    out = out.split(lit).join(" ")
  }
  return out
}

/**
 * Checks every figure in `text` against `allowed`. Returns the first figure
 * that is not allowed (or not exactly readable) as the reason.
 */
export function checkFigures(rawText: string, allowed: Allowed): CheckResult {
  const amounts = new Set([...allowed.amountsCents].map((v) => Math.abs(Math.round(v))))
  const percents = new Set([...(allowed.percents ?? [])].map((v) => Math.abs(v)))
  const dates = new Set(allowed.dates ?? [])
  const months = new Set([...(allowed.months ?? []), ...[...dates].map((d) => d.slice(0, 7))])
  // A year the facts cover may be named on its own ("in 2026").
  const numbers = new Set([...(allowed.numbers ?? []), ...[...months].map((m) => Number(m.slice(0, 4)))].map((v) => Math.abs(v)))
  const monthNums = new Set([...months].map((m) => Number(m.slice(5, 7)) - 1))

  let text = strip(norm(rawText), [...(allowed.literals ?? [])].map(norm))

  // Any digit NFKC could not make ASCII (Arabic-Indic, Devanagari, …) is a figure this check cannot read.
  if (/(?![0-9])\p{Nd}/u.test(text)) return fail("figure in a non-ASCII script")
  if (SLASH_DATE.test(text)) return fail(`date not in YYYY-MM-DD form: "${text.match(SLASH_DATE)![0]}"`)
  if (RELATIVE_DATES.test(text)) return fail(`relative date: "${text.match(RELATIVE_DATES)![0]}"`)
  if (ABBREVIATED.test(text)) return fail(`abbreviated figure: "${text.match(ABBREVIATED)![0]}"`)
  if (SCALE_WORDS.test(text)) return fail(`figure in words: "${text.match(SCALE_WORDS)![0]}"`)

  let bad: string | null = null
  const take = (re: RegExp, check: (m: RegExpExecArray) => boolean) => {
    text = text.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray
      if (bad === null && !check(m)) bad = m[0]
      return " "
    })
  }
  take(ISO_DATE, (m) => dates.has(m[0]))
  if (bad) return fail(`date not given: "${bad}"`)
  take(ISO_MONTH, (m) => months.has(m[0]))
  if (bad) return fail(`month not given: "${bad}"`)
  const dayOk = (day: string, monthWord: string, year: string | undefined) => {
    const mi = monthIndex(monthWord)
    if (mi === null) return false
    const mm = String(mi + 1).padStart(2, "0")
    const dd = day.padStart(2, "0")
    return [...dates].some((d) => d.slice(5) === `${mm}-${dd}` && (!year || d.startsWith(year)))
  }
  take(DAY_MONTH, (m) => dayOk(m[1], m[2], m[3]))
  if (bad) return fail(`date not given: "${bad}"`)
  take(MONTH_DAY, (m) => dayOk(m[2], m[1], m[3]))
  if (bad) return fail(`date not given: "${bad}"`)
  take(MONTH_YEAR, (m) => {
    const mi = monthIndex(m[1])
    return mi !== null && months.has(`${m[2]}-${String(mi + 1).padStart(2, "0")}`)
  })
  if (bad) return fail(`month not given: "${bad}"`)

  // A month named alone must be a month the facts cover.
  for (const word of text.match(/\b[A-Za-z]+\.?/g) ?? []) {
    const mi = monthIndex(word.replace(/\.$/, ""))
    if (mi !== null && !monthNums.has(mi)) return fail(`month not given: "${word}"`)
  }
  const words = text.toLowerCase().match(/[a-z]+|[.,;:!?]/g) ?? []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (!Object.prototype.hasOwnProperty.call(NUMBER_WORDS, word)) continue
    if (word === "one" && isPronoun(words[i - 1], words[i + 1])) continue
    if (!numbers.has(NUMBER_WORDS[word])) return fail(`figure in words not given: "${word}"`)
  }

  const monthly = new Set([...(allowed.monthlyAmountsCents ?? [])].map((v) => Math.abs(Math.round(v))))
  for (const m of text.matchAll(FIGURE)) {
    const [whole, , currency, , intPart, frac, unitRaw] = m
    const unit = (unitRaw ?? "").trim().toLowerCase()
    const value = Number(intPart.replace(/[  ,]/g, "") + (frac ?? ""))
    if (!Number.isFinite(value)) return fail(`unreadable figure: "${whole.trim()}"`)
    if (unit === "%" || unit === "percent" || unit === "per cent") {
      if (currency) return fail(`unreadable figure: "${whole.trim()}"`)
      if (!percents.has(value)) return fail(`percentage not given: "${whole.trim()}"`)
    } else if (unit === "c" || unit === "cents") {
      if (currency || frac || !amounts.has(value)) return fail(`amount not given: "${whole.trim()}"`)
    } else if (currency || unit === "rand") {
      if (frac && frac.length !== 3) return fail(`amount not in rand and cents: "${whole.trim()}"`)
      if (!amounts.has(Math.round(value * 100))) return fail(`amount not given: "${whole.trim()}"`)
      // A total called a month's figure is the wrong figure, however exact its digits.
      const after = text.slice(m.index + whole.length, m.index + whole.length + 30)
      if (MONTHLY.test(after) && !monthly.has(Math.round(value * 100))) return fail(`amount called monthly is not a monthly figure: "${whole.trim()}"`)
    } else if (!numbers.has(value)) {
      return fail(`number not given: "${whole.trim()}"`)
    }
  }
  // A digit left over sits where no figure pattern could read it (glued to letters, say): unreadable.
  const residue = text.replace(FIGURE, " ")
  const stray = residue.match(/\S*\d\S*/)
  if (stray) return fail(`unreadable figure: "${stray[0]}"`)
  return OK
}

/** Words that call something fine. Any of them, while a flag is raised, rejects the output. */
const REASSURANCE = /\b(acceptable|normal(ly)?|fine|resolved|ok(ay)?|no (cause for )?concerns?|not (a )?concern(ing)?|nothing to worry|not worrying|can be ignored|safe to ignore|ignor(e|ed|ing)|insignificant|not significant|harmless|benign|explained|as expected|cleared|no issues?|not an issue|low[- ]risk|no risk|minor|nothing unusual|unremarkable|false (positive|alarm)|reasonable|satisfactory|legitimate|justified|not a problem|no problem|in order|consistent with policy)\b/i

/** Decisions belong to the officer, and authenticity verdicts to the rules' evidence: never to the model. */
const VERDICT = /\b(approv\w*|declin\w*|recommend\w*|reject the|accept the (application|loan|client)|creditworthy|genuine|authentic(ity)? (is|was) (confirmed|verified)|tampered|forged|forgery|fake|fraud\w*|doctored|falsified)\b/i

/**
 * §2a.4: no output may contradict a raised flag. With any flag raised,
 * reassurance anywhere rejects (deterministic: no reading of which sentence
 * is about which flag). Verdicts reject always.
 */
export function checkNoContradiction(rawText: string, raisedFlagCodes: readonly string[]): CheckResult {
  // Masked keys are not stripped here: a payee named "ALL FLAGS RESOLVED" is
  // statement text a client can write, and the officer would read it as a verdict.
  const text = norm(rawText)
  const verdict = text.match(VERDICT)
  if (verdict) return fail(`verdict language: "${verdict[0]}"`)
  if (raisedFlagCodes.length > 0) {
    const calm = text.match(REASSURANCE)
    if (calm) return fail(`reassurance while a flag is raised: "${calm[0]}"`)
  }
  return OK
}

/** Which way a flag's figure departs from what was expected; null for flags that are presence, not size. */
export type Direction = "ABOVE" | "BELOW"

const ABOVE_WORDS = /\b(above|over|more than|exceed(s|ed|ing)?|higher|greater|larger|older than|after)\b/i
const BELOW_WORDS = /\b(below|under|less than|lower|smaller|short of|beneath|before|within)\b/i
const THRESHOLD_WORDS = /\b(threshold|tolerance|policy|limit)\b/i

export interface FlagSpec {
  code: string
  direction: Direction | null
  /** The policy threshold(s), as the facts give them: a threshold sentence may state only these. */
  thresholds: Allowed
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim())
}

/**
 * §4: an explanation names the flag's exact code, says which way it departs
 * (and never the other way in a sentence naming the code), and states no
 * threshold but the policy value.
 */
export function checkFlagExplanation(rawText: string, flag: FlagSpec): CheckResult {
  const text = norm(rawText)
  if (!new RegExp(`(^|[^A-Z0-9_])${flag.code}([^A-Z0-9_]|$)`).test(text)) return fail(`does not name the flag code ${flag.code}`)
  if (flag.direction) {
    const want = flag.direction === "ABOVE" ? ABOVE_WORDS : BELOW_WORDS
    const opposite = flag.direction === "ABOVE" ? BELOW_WORDS : ABOVE_WORDS
    if (!want.test(text)) return fail(`does not say the figure is ${flag.direction.toLowerCase()} what was expected`)
    for (const s of sentences(text)) {
      if (s.includes(flag.code) && opposite.test(s)) return fail(`states the opposite direction: "${s.match(opposite)![0]}"`)
    }
  }
  // The figure a threshold word introduces ("the policy threshold of 5%") or
  // qualifies ("the 5% policy limit") must be the policy's. In a threshold
  // sentence no figure may be written in words: the figure check reads a
  // word as a count, never as the percentage it may stand for.
  for (const s of sentences(strip(text, [flag.code]))) {
    const words = [...s.matchAll(new RegExp(THRESHOLD_WORDS.source, "gi"))]
    if (words.length === 0) continue
    const spelled = s.toLowerCase().match(/\b[a-z]+\b/g)?.find((w) => Object.prototype.hasOwnProperty.call(NUMBER_WORDS, w))
    if (spelled) return fail(`threshold other than policy: figure in words: "${spelled}"`)
    for (const word of words) {
      const after = new RegExp(FIGURE.source, "i").exec(s.slice(word.index + word[0].length))
      // Up to three words before it: "the 5% policy limit", "R50.00 tolerance".
      const before = [...s.slice(0, word.index).split(/\s+/).slice(-4).join(" ").matchAll(new RegExp(FIGURE.source, "gi"))].pop()
      for (const figure of [after, before]) {
        if (!figure) continue
        const r = checkFigures(figure[0], flag.thresholds)
        if (!r.ok) return fail(`threshold other than policy: ${r.reason}`)
      }
    }
  }
  return OK
}

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
  const contradiction = checkNoContradiction(input.text, input.raisedFlagCodes)
  if (!contradiction.ok) return contradiction
  return input.flag ? checkFlagExplanation(input.text, input.flag) : OK
}

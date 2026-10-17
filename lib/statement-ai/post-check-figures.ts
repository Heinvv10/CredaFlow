/**
 * The post-check's figure rule: an allowlist of the figures the model was
 * given, each as the exact token it was written as (see post-check.ts).
 */
import { rand } from "./format"
import { escape, fail, norm, OK, stripLiterals, type Allowed, type CheckResult } from "./post-check-core"

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
const MONTH_ABBR = /\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b\.?/
const WEEKDAYS = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/i
const ORDINAL_WORDS = /\b(third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|(thir|four|fif|six|seven|eigh|nine)teenth|twentieth|thirtieth)\b/i
/** Words that are a figure but never an exact given one. */
const QUANTITY_WORDS = /\b(zero|none|nil|nought|naught|single|pairs?|both|once|twice|thrice|couple|dozens?|hundreds?|thousands?|millions?|billions?|trillions?|half|halves|quarters?|thirds|double[sd]?|tripled?|quadrupled?|pct|per ?mille|basis points?|bps|percentage points?)\b/i
const RELATIVE_DATES = /\b(yesterday|today|tomorrow|(last|next|this|previous|coming|past) (week|month|year|quarter|fortnight)|ago)\b/i
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}
const isNumberWord = (w: string | undefined) => w !== undefined && Object.prototype.hasOwnProperty.call(NUMBER_WORDS, w)

/** Words after an amount that make it a month's figure. */
const MONTHLY = /^[^.;:!?]{0,12}?\b(monthly|per month|a month|each month|every month|p\.?m\.?)(\b|$)/i
const IN_WORDS = /\b(received|receives|receiving|earned|earns|credited|deposited|came in|paid in)\b/i
const OUT_WORDS = /\b(spent|paid to|paid out|debited|withdrew|withdrawn|went to|sent to)\b/i

/** "one" as a pronoun ("no one", "matched to one.", "one of"), not a count. */
function isPronoun(before: string | undefined, after: string | undefined): boolean {
  return ["no", "the", "this", "that", "each", "any", "every", "which", "to", "a", "another"].includes(before ?? "") ||
    after === undefined || /^[.,;:!?]$/.test(after) || ["of", "another", "or"].includes(after)
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+/).filter((s) => s.trim())
}

/** Every given figure as the token the model must copy, longest first. */
function tokens(allowed: Allowed) {
  const amounts = [...new Set([...allowed.amountsCents].map((c) => Math.round(c)))].map((c) => ({ cents: c, text: rand(c) }))
  const dates = [...new Set(allowed.dates ?? [])]
  const months = [...new Set([...(allowed.months ?? []), ...dates.map((d) => d.slice(0, 7))])]
  const years = [...new Set(months.map((m) => Number(m.slice(0, 4))))]
  const percents = [...new Set(allowed.percents ?? [])].flatMap((p) => [`${p}%`, `${p} percent`, `${p} per cent`])
  const numbers = [...new Set([...(allowed.numbers ?? []), ...years])]
  return { amounts, dates, months, percents, numbers }
}

/**
 * Checks every figure in `text` against `allowed`. Returns the first figure
 * that is not allowed, or not written as given, as the reason.
 */
export function checkFigures(rawText: string, allowed: Allowed): CheckResult {
  let text = stripLiterals(norm(rawText), allowed.literals ?? [])
  if (/(?![0-9])\p{Nd}/u.test(text)) return fail("figure in a non-ASCII script")
  if (/[⁄‰‱]/.test(text)) return fail("fraction or per-mille sign")
  const lower = text.toLowerCase()
  for (const [re, what] of [[QUANTITY_WORDS, "figure in words"], [ORDINAL_WORDS, "ordinal"], [WEEKDAYS, "weekday"], [RELATIVE_DATES, "relative date"]] as const) {
    const m = text.match(re)
    if (m) return fail(`${what}: "${m[0]}"`)
  }
  const monthName = lower.match(/[a-z]+/g)?.find((w, i) => MONTHS.includes(w) && !((w === "may" || w === "march") && text.match(/[A-Za-z]+/g)?.[i] === w))
  if (monthName) return fail(`month name, not YYYY-MM: "${monthName}"`)
  const abbr = text.match(MONTH_ABBR)
  if (abbr) return fail(`month name, not YYYY-MM: "${abbr[0]}"`)

  const words = lower.match(/[a-z]+|[-.,;:!?]/g) ?? []
  const t = tokens(allowed)
  const numbers = new Set(t.numbers)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (!isNumberWord(w)) continue
    if (w === "one" && isPronoun(words[i - 1], words[i + 1])) continue
    // "twenty-one", "forty two": a compound is never read as its parts.
    const joined = (words[i + 1] === "-" && isNumberWord(words[i + 2])) || isNumberWord(words[i + 1]) || (words[i - 1] === "-" && isNumberWord(words[i - 2])) || isNumberWord(words[i - 1])
    if (joined) return fail(`compound figure in words: "${w}"`)
    if (!numbers.has(NUMBER_WORDS[w])) return fail(`figure in words not given: "${w}"`)
  }

  const direction = checkDirections(text, allowed, t.amounts)
  if (!direction.ok) return direction

  const monthly = new Set([...(allowed.monthlyAmountsCents ?? [])].map((c) => Math.round(c)))
  for (const a of t.amounts.sort((x, y) => y.text.length - x.text.length)) {
    const re = new RegExp(`(?<![\\w.,-])${escape(a.text)}(?!\\d|[.,]\\d)`, "g")
    let bad = false
    text = text.replace(re, (m, offset: number, whole: string) => {
      if (MONTHLY.test(whole.slice(offset + m.length, offset + m.length + 30)) && !monthly.has(a.cents)) bad = true
      return " "
    })
    if (bad) return fail(`amount called monthly is not a monthly figure: "${a.text}"`)
  }
  for (const s of [...t.dates, ...t.months].sort((x, y) => y.length - x.length)) {
    text = text.replace(new RegExp(`(?<![\\w-])${escape(s)}(?![\\w-])`, "g"), " ")
  }
  for (const p of t.percents.sort((x, y) => y.length - x.length)) {
    text = text.replace(new RegExp(`(?<![\\w.,-])${escape(p)}(?![\\w%])`, "g"), " ")
  }
  for (const n of t.numbers.map(String).sort((x, y) => y.length - x.length)) {
    // Not when a percentage sign or word follows: a count is not a percentage.
    text = text.replace(new RegExp(`(?<![\\w.,/-])${escape(n)}(?![\\w%/]|[.,]\\d|\\s?(%|percent\\b|per cent\\b))`, "gi"), " ")
  }
  const left = text.match(/\S*\d\S*/)
  if (left) return fail(`figure not given as written: "${left[0]}"`)
  return OK
}

/** A sentence about money coming in may not cite an amount that went out, nor the reverse. */
function checkDirections(text: string, allowed: Allowed, amounts: Array<{ cents: number; text: string }>): CheckResult {
  const ins = new Set([...(allowed.inAmountsCents ?? [])].map((c) => Math.round(c)))
  const outs = new Set([...(allowed.outAmountsCents ?? [])].map((c) => Math.round(c)))
  for (const s of sentencesOf(text)) {
    const saysIn = IN_WORDS.test(s)
    const saysOut = OUT_WORDS.test(s)
    if (saysIn === saysOut) continue
    for (const a of amounts) {
      if (!new RegExp(`(?<![\\w.,-])${escape(a.text)}(?!\\d|[.,]\\d)`).test(s)) continue
      if (saysIn && outs.has(a.cents) && !ins.has(a.cents)) return fail(`money out called money in: "${a.text}"`)
      if (saysOut && ins.has(a.cents) && !outs.has(a.cents)) return fail(`money in called money out: "${a.text}"`)
    }
  }
  return OK
}

/**
 * The post-check's figure rule: an allowlist of the figures the model was
 * given, each as the exact token it was written as (see post-check.ts).
 */
import { rand } from "./format"
import { escape, fail, norm, OK, stripLiterals, type Allowed, type CheckResult } from "./post-check-core"

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
const MONTH_ABBR = /\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b\.?(?=\s*\d)|\b(JAN|FEB|MAR|APR|JUN|JUL|AUG|SEPT?|OCT|NOV|DEC)\b|\b(Jan|Feb|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b/
const WEEKDAYS = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/i
const ORDINAL_WORDS = /\b((first|second)(?= *(of\b|[.,;:!?]|$))|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|(thir|four|fif|six|seven|eigh|nine)teenth|twentieth|thirtieth)\b/i
/** Words that are a figure but never an exact given one. */
const QUANTITY_WORDS = /\b(zero|none|nil|nought|naught|single|pairs?|both|once|twice|thrice|couple|dozens?|hundreds?|thousands?|millions?|billions?|trillions?|half|halves|quarters?|thirds|double[sd]?|tripled?|quadrupled?|pct|per ?mille|basis points?|bps|percentage points?)\b/i
const RELATIVE_DATES = /\b(yesterday|today|tomorrow|(last|next|this|previous|coming|past) (week|month|year|quarter|fortnight)|ago)\b/i
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}
const isNumberWord = (w: string | undefined) => w !== undefined && Object.prototype.hasOwnProperty.call(NUMBER_WORDS, w)

/** A word that states a figure, an order or a date ("FIVE THOUSAND", "TWELFTH", "MAY"), or null. */
export function figureWord(text: string): string | null {
  for (const re of [QUANTITY_WORDS, ORDINAL_WORDS, WEEKDAYS, RELATIVE_DATES]) {
    const m = text.match(re)
    if (m) return m[0]
  }
  return text.toLowerCase().match(/[a-z]+/g)?.find((w) => MONTHS.includes(w) || isNumberWord(w)) ?? null
}

/** Words after an amount that make it a month's figure. */
const MONTHLY = /^(?:[^.;:!?,()]{0,12}?\b|[ ,(/]{0,3})(monthly|per month|a month|each month|every month|for the month|in a month|month|mth|p\.?m\.?|p\/m)(\b|$)/i
const OTHER_PERIOD = /^(?:[^.;:!?,()]{0,8}?\b|[ ,(]{0,3})(weekly|daily|yearly|annually|fortnightly|a (week|day|year|fortnight)|per (week|day|year|annum|fortnight)|each (week|day|year|fortnight)|every (week|day|year|fortnight))\b/i

const TOTAL_AFTER = /^[^.;:!?,()]{0,12}?\b(in total|over the (whole |entire )?(statement )?period|altogether|across (the|all) (statements|months))\b/i
const TOTAL_BEFORE = /\b(total|totals|totalled|totaled|totalling|totaling|in all)\b[^.;:!?,]{0,20}$/i

/** The same words before an amount, in its clause: "monthly rent of R8 500.00". */
const MONTHLY_BEFORE = /\b(monthly|per month|a month|each month|every month|month's)\b[^.;:!?,]{0,25}$/i
/** Words that say which way money moved. Bare "credit" and "payments" are left out: "credit instalments" are money out, "salary payments" money in. */
const IN_CUE = /^(received|receives|receiving|earned|earns|credited|deposited|deposits?|came in|paid in|money in|income|incoming|salary|salaries|inflows?|wages?)$/i
const DIRECTION_CUES = /\b(received|receives|receiving|earned|earns|credited|deposited|deposits?|came in|paid in|money in|income|incoming|salary|salaries|inflows?|wages?|spent|spends?|spending|paid to|paid out|payments? to|debited|debits?|debit orders?|withdrew|withdrawn|withdrawals?|went to|sent to|money out|outgoing|outflows?|expenses?|costs?)\b/gi

/** "one" as a pronoun ("no one", "the one", "one of"), not a count. A bare "one." is a count. */
function isPronoun(before: string | undefined, after: string | undefined): boolean {
  return ["no", "the", "this", "that", "each", "any", "another"].includes(before ?? "") || after === "of"
}

/** Clauses: a sentence split at commas, semicolons and joining words, so "money in X, and money out Y" is two. */
function clausesOf(text: string): string[] {
  return text.split(/[.!?;,]\s+|\s(?:and|while|whereas|but)\s/i).filter((s) => s.trim())
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
  // A quoted payee (render.ts) is a name, not a direction: "SALARY ADVANCE CO" names who was paid. Payee keys hold
  // only A-Z, & and spaces (labelKey), so a quote cannot be smuggled inside one. One with a figure word is still read.
  let text = stripLiterals(norm(rawText).replace(/"([A-Z&][A-Z& ]*)"/g, (m, key: string) => (figureWord(key) ? m : '"payee"')), allowed.literals ?? [])
  if (/(?![0-9])\p{Nd}/u.test(text)) return fail("figure in a non-ASCII script")
  if (/[⁄‰‱]/.test(text)) return fail("fraction or per-mille sign")
  // "R8 500.00k", "R2 bn": a scale written after a figure, even a given one.
  const abbreviated = text.match(/\d\s*(k|m|bn|mn|mil|mill?|thou)\b/i)
  if (abbreviated) return fail(`abbreviated figure: "${abbreviated[0]}"`)
  const lower = text.toLowerCase()
  for (const [re, what] of [[QUANTITY_WORDS, "figure in words"], [ORDINAL_WORDS, "ordinal"], [WEEKDAYS, "weekday"], [RELATIVE_DATES, "relative date"]] as const) {
    const m = text.match(re)
    if (m) return fail(`${what}: "${m[0]}"`)
  }
  const monthName = lower.match(/[a-z]+/g)?.find((w, i) => MONTHS.includes(w) && !((w === "may" || w === "march") && text.match(/[A-Za-z]+/g)?.[i] === w))
  if (monthName) return fail(`month name, not YYYY-MM: "${monthName}"`)
  // "may" and "march" are verbs in lower case, but not before a year or a day.
  const verbMonth = text.match(/\b(may|march)\s+\d/i)
  if (verbMonth) return fail(`month name, not YYYY-MM: "${verbMonth[0]}"`)
  const abbr = text.match(MONTH_ABBR) ?? text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)\.?\s*\d/i)
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
    if (["percent", "percentage", "pc", "per"].includes(words[i + 1] ?? "")) return fail(`percentage in words: "${w}"`)
    if (!numbers.has(NUMBER_WORDS[w])) return fail(`figure in words not given: "${w}"`)
  }

  const direction = checkDirections(text, allowed, t.amounts)
  if (!direction.ok) return direction

  const monthly = new Set([...(allowed.monthlyAmountsCents ?? [])].map((c) => Math.round(c)))
  // Without a period list (a caller that gives none), every given amount may be a total.
  const period = new Set([...(allowed.periodAmountsCents ?? allowed.amountsCents)].map((c) => Math.round(c)))
  for (const a of t.amounts.sort((x, y) => y.text.length - x.text.length)) {
    const re = new RegExp(`(?<![\\w.,-])${escape(a.text)}(?!\\w|[.,]\\d|\\s?%)`, "g")
    let bad = false
    text = text.replace(re, (m, offset: number, whole: string) => {
      const calledMonthly = MONTHLY.test(whole.slice(offset + m.length, offset + m.length + 30)) || MONTHLY_BEFORE.test(whole.slice(Math.max(0, offset - 30), offset))
      if (calledMonthly && !monthly.has(a.cents)) bad = true
      // A month's figure called a total ("R9 000.00 over the period") is the wrong figure too.
      const calledTotal = TOTAL_AFTER.test(whole.slice(offset + m.length, offset + m.length + 30)) || TOTAL_BEFORE.test(whole.slice(Math.max(0, offset - 30), offset))
      if (calledTotal && monthly.has(a.cents) && !period.has(a.cents)) bad = true
      // No fact is weekly, daily or yearly: an amount called so is never the figure given.
      if (OTHER_PERIOD.test(whole.slice(offset + m.length, offset + m.length + 30))) bad = true
      return " "
    })
    if (bad) return fail(`amount given another period than its own: "${a.text}"`)
  }
  for (const s of [...t.dates, ...t.months].sort((x, y) => y.length - x.length)) {
    text = text.replace(new RegExp(`(?<![\\w-])${escape(s)}(?![\\w-])`, "g"), " ")
  }
  for (const p of t.percents.sort((x, y) => y.length - x.length)) {
    text = text.replace(new RegExp(`(?<![\\w.,-])${escape(p)}(?![\\w%]|[.,]\\d)`, "g"), " ")
  }
  for (const n of t.numbers.map(String).sort((x, y) => y.length - x.length)) {
    // Not when a percentage sign or word follows: a count is not a percentage.
    // Nor beside another digit group ("3 92" is not two counts): space-grouped digits read as one figure.
    text = text.replace(new RegExp(`(?<![\\w.,/-])(?<!\\d )${escape(n)}(?![\\w%/]|[.,]\\d| \\d|\\s?(%|percent\\b|percentage\\b|pc\\b|per ?cent\\b))`, "gi"), " ")
  }
  const left = text.match(/\S*\d\S*/)
  if (left) return fail(`figure not given as written: "${left[0]}"`)
  return OK
}

/** A clause about money coming in may not cite an amount that went out, nor the reverse. */
function checkDirections(text: string, allowed: Allowed, amounts: Array<{ cents: number; text: string }>): CheckResult {
  const ins = new Set([...(allowed.inAmountsCents ?? [])].map((c) => Math.round(c)))
  const outs = new Set([...(allowed.outAmountsCents ?? [])].map((c) => Math.round(c)))
  // Each amount is read with the direction word nearest it in its clause (before it first, else after):
  // "received R1 000.00 and spent R10 000.00" checks each against its own verb.
  for (const clause of clausesOf(text)) {
    const cues = [...clause.matchAll(DIRECTION_CUES)].map((m) => ({ at: m.index, way: IN_CUE.test(m[0]) ? "in" : "out" }))
    if (cues.length === 0) continue
    for (const a of amounts) {
      for (const m of clause.matchAll(new RegExp(`(?<![\\w.,-])${escape(a.text)}(?!\\w|[.,%]\\d|%)`, "g"))) {
        const before = cues.filter((c) => c.at < m.index).pop()
        const way = (before ?? cues.find((c) => c.at > m.index))?.way
        if (way === "in" && outs.has(a.cents) && !ins.has(a.cents)) return fail(`money out called money in: "${a.text}"`)
        if (way === "out" && ins.has(a.cents) && !outs.has(a.cents)) return fail(`money in called money out: "${a.text}"`)
      }
    }
  }
  return OK
}

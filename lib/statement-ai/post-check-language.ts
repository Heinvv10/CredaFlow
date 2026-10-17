/**
 * The post-check's language rules (goal §2a.4, §4). The rules' flags stay the
 * decision: with any flag raised, an output that calls anything fine is
 * rejected; an output that recommends a decision, or gives its own verdict on
 * a document, a client or their risk, is rejected always. Blocklists cannot
 * be complete, so the text is narrowed first: Latin letters only (no
 * look-alike letters from other scripts), invisible characters removed,
 * whitespace collapsed. The same lists withhold payee names (facts.ts
 * safeKey), so statement text can never say these things for the model.
 */
import { fail, norm, OK, stripLiterals, type Allowed, type CheckResult } from "./post-check-core"
import { checkFigures } from "./post-check-figures"
import { ALLOWED_NEGATIONS, VOCABULARY } from "./post-check-vocabulary"

/** Words that call something fine (English and Afrikaans). */
export const REASSURANCE = new RegExp([
  "acceptable", "aanvaarbaar", "normal(ly)?", "normaal", "typical(ly)?", "usual", "routine", "standard", "fine", "ok(ay)?", "good", "goed",
  "healthy", "stable", "sound", "solid", "safe", "veilig", "clean", "adequate", "satisfactory", "reasonable", "reassuring", "encouraging",
  "favou?rable", "positive", "unproblematic", "non-?issue", "harmless", "benign", "insignificant", "minor", "negligible", "trivial",
  "resolved", "cleared", "explained", "justified", "legitimate", "in order", "in orde", "all clear", "all good", "no red flags?",
  "as expected", "is expected", "in line with", "within (policy|limits?|range|expectations|the norm|norms)", "consistent with policy",
  "nothing (to (worry|flag|note)|of (note|concern)|unusual|concerning|wrong|suspicious|alarming|untoward)", "can be ignored",
  "safe to ignore", "ignor(e|ed|ing)", "false (positive|alarm)", "geen (probleem|kommer)", "no (cause for )?concerns?",
  "no (issues?|problems?)", "unremarkable",
].map((w) => `\\b${w}\\b`).join("|"), "i")

/** A negated finding: "isn't a concern", "not unusual", "no sign of risk". */
export const NEGATED_FINDING = /\b(not|no|never|nothing|without|isn't|aren't|wasn't|weren't|doesn't|don't|didn't)\b(\W+\w+){0,3}?\W+(concern\w*|issues?|problem\w*|worr\w*|alarm\w*|flags?|unusual|suspicious|irregular\w*|anomal\w*|risk\w*|signs? of)\b/i

/** The same, negated after the finding: "signs of risk were not seen", "no issue was found". */
export const NEGATED_AFTER = /\b(concern\w*|issues?|problems?|risks?|signs?|anomal\w*|irregular\w*|tamper\w*|alteration\w*)\b(\W+\w+){0,3}?\W+(not|never)\b(\W+\w+)?\W+(seen|found|present|detected|identified|observed|noted|shown|evident)\b/i

/** Decisions belong to the officer; verdicts on a document, a client or their risk to the rules' evidence. */
export const VERDICT = new RegExp([
  "approv\\w*", "declin\\w*", "recommend\\w*", "reject\\w*", "accept(s|ed|ing)?", "grant\\w*", "lend\\w*", "proceed\\w*",
  "turn(ed|s)? down", "den(y|ied|ies)", "refus\\w*", "(un)?creditworth\\w*", "afford\\w*", "eligib\\w*", "suitab\\w*",
  "trust(worthy|ed|s)?", "reliab\\w*", "suspicious\\w*", "fraud\\w*", "risky", "(high|low|elevated|moderate|minimal|little)[- ]risk",
  "genuine\\w*", "authentic\\w*", "unaltered", "untampered", "tamper\\w*", "forg(ed|ery|eries)", "fake\\w*", "doctored",
  "falsifi\\w*", "manipulat\\w*", "fabricat\\w*", "altered", "edited", "counterfeit", "bogus", "legit\\w*", "verif(y|ied|ies|ication)(?! against a payslip)", "real",
  "(is|was|are|were|been|being|appears?|looks?|seems?) (true|correct|clean|accurate|valid|honest|sound|in order)",
].map((w) => `\\b${w}\\b`).join("|"), "i")

/**
 * Letters as the lists read them: accents and other combining marks removed
 * (NFKD), so "finé" is "fine". Then any letter outside A-Z rejects the output:
 * a look-alike from another script ("fіne") or an unfolded letter could hide a word.
 */
export function plainLetters(text: string): string {
  return norm(text).normalize("NFKD").replace(/\p{M}/gu, "")
}

export function foreignLetter(text: string): string | null {
  return plainLetters(text).match(/(?![A-Za-z])\p{L}/u)?.[0] ?? null
}

/** Reassurance with a flag raised, a verdict at any time. Exported for the stale-output re-check (views.ts). */
export function checkNoContradiction(rawText: string, raisedFlagCodes: readonly string[]): CheckResult {
  const letter = foreignLetter(rawText)
  if (letter) return fail(`letter outside A-Z: "${letter}"`)
  // Flag codes are names, not words ("RISK_BEHAVIOUR"); payee names are not stripped: a client can name a payee.
  const text = stripLiterals(plainLetters(rawText), raisedFlagCodes)
  const verdict = text.match(VERDICT)
  if (verdict) return fail(`verdict language: "${verdict[0]}"`)
  if (raisedFlagCodes.length > 0) {
    const calm = text.match(REASSURANCE) ?? text.match(NEGATED_FINDING) ?? text.match(NEGATED_AFTER)
    if (calm) return fail(`reassurance while a flag is raised: "${calm[0]}"`)
  }
  return OK
}

/**
 * Every word must be on the advisory vocabulary (post-check-vocabulary.ts) or
 * be a name the facts gave, as written. Figures are checked elsewhere: any
 * token with a digit is skipped here.
 */
export function checkVocabulary(rawText: string, names: Iterable<string>, payeeNames: Iterable<string> = []): CheckResult {
  const payees = new Set(payeeNames)
  // Names from the system (banks, categories, checks, codes) match in any case ("Capitec" for
  // "CAPITEC"). A payee's name is statement text a client can write: it matches only as given, in
  // capitals, so it reads as a name and can never lend the prose an ordinary word.
  const trusted = [...names].filter((n) => !payees.has(n))
  const payeeWords = [...payees].flatMap((n) => [n, ...n.split(" ").filter((w) => w.length > 2)])
  let text = stripLiterals(stripLiterals(plainLetters(rawText), trusted, "i"), payeeWords)
  text = text.replace(/\S*\d\S*/g, " ").replace(ALLOWED_NEGATIONS, " ")
  for (const word of text.match(/[A-Za-z]+(?:['-][A-Za-z]+)*/g) ?? []) {
    const w = word.toLowerCase().replace(/'s$/, "")
    if (VOCABULARY.has(w)) continue
    if (w.includes("-") && w.split("-").every((part) => VOCABULARY.has(part))) continue
    return fail(`word outside the advisory vocabulary: "${word}"`)
  }
  return OK
}

/** Every language rule: the vocabulary, then reassurance and verdicts (kept: they name the failure plainly). */
export function checkLanguage(rawText: string, raisedFlagCodes: readonly string[], names: Iterable<string> = [], payees: Iterable<string> = []): CheckResult {
  const contradiction = checkNoContradiction(rawText, raisedFlagCodes)
  if (!contradiction.ok) return contradiction
  return checkVocabulary(rawText, [...names, ...raisedFlagCodes], payees)
}

/** Which way a flag's figure departs from what was expected; null for flags that are presence, not size. */
export type Direction = "ABOVE" | "BELOW"

const ABOVE_WORDS = /\b(above|more than|exceed(s|ed|ing)?|higher than|greater than|larger than|older than)\b/i
const BELOW_WORDS = /\b(below|less than|lower than|smaller than|short of|under)\b/i
const NEGATION = /\b(not|never|no|none|cannot|can't|unable|fails?|failed|neither|nor|appears?|seems?|may|might|could|possibly|perhaps|unlikely)\b|n't\b/i
const THRESHOLD_WORDS = /\b(threshold|tolerance|policy|limit|share|cut-?off|maximum|minimum)\b/i

export interface FlagSpec {
  code: string
  direction: Direction | null
  /** The policy threshold(s), as the facts give them: a threshold sentence may state only these. */
  thresholds: Allowed
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+/).filter((s) => s.trim())
}

/** Every percentage an explanation states must be a policy threshold: no flag's facts carry another. */
function percentsOf(text: string): string[] {
  return [...text.matchAll(/(\d+(?:\.\d+)?)\s?(%|percent|per cent)/gi)].map((m) => m[1])
}

/**
 * §4: an explanation names the flag's exact code, says which way it departs
 * (never negated, never the other way), and states no threshold but the
 * policy value: every percentage is a policy percentage, and the figure a
 * threshold word introduces or qualifies is a policy figure.
 */
export function checkFlagExplanation(rawText: string, flag: FlagSpec): CheckResult {
  const text = norm(rawText)
  if (!new RegExp(`(^|[^A-Z0-9_])${flag.code}([^A-Z0-9_]|$)`).test(text)) return fail(`does not name the flag code ${flag.code}`)
  const body = stripLiterals(text, [flag.code])
  if (flag.direction) {
    const want = flag.direction === "ABOVE" ? ABOVE_WORDS : BELOW_WORDS
    const opposite = flag.direction === "ABOVE" ? BELOW_WORDS : ABOVE_WORDS
    const hit = body.match(want)
    if (!hit) return fail(`does not say the figure is ${flag.direction.toLowerCase()} what was expected`)
    // No negation or doubt anywhere in a sentence that states the direction.
    for (const sentence of sentences(body)) {
      if (!want.test(sentence)) continue
      const doubt = sentence.match(NEGATION)
      if (doubt) return fail(`negates the direction: "${doubt[0]}"`)
    }
    const other = body.match(opposite)
    if (other) return fail(`states the opposite direction: "${other[0]}"`)
  }
  const policyPercents = new Set([...(flag.thresholds.percents ?? [])].map(String))
  const stray = percentsOf(body).find((p) => !policyPercents.has(String(Number(p))))
  if (stray !== undefined) return fail(`threshold other than policy: "${stray}%"`)
  const figure = /-?R\d[\d ]*\.\d{2}|\d+(?:\.\d+)?\s?(?:%|percent|per cent|days?|seconds?)?/gi
  for (const s of sentences(body)) {
    for (const word of s.matchAll(new RegExp(THRESHOLD_WORDS.source, "gi"))) {
      const after = new RegExp(figure.source, "i").exec(s.slice(word.index + word[0].length))
      const before = [...s.slice(0, word.index).split(/\s+/).slice(-4).join(" ").matchAll(figure)].pop()
      for (const f of [after, before]) {
        if (!f) continue
        const r = checkFigures(f[0].trim(), flag.thresholds)
        if (!r.ok) return fail(`threshold other than policy: ${r.reason}`)
      }
    }
  }
  return OK
}

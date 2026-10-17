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
  "approv\\w*", "declin\\w*", "recommend\\w*", "reject\\w*", "accept(s|ed|ing)?", "grant\\w*", "lend(s|ing|ed)?", "(should|could|can|to|not) lend\\w*", "proceed\\w*",
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
  // Only the whole payee phrase: a single word of it ("ORDINARY" of "ORDINARY JOES") must not stand alone.
  // Payees first, whole and as given: a system name inside one ("HOUSING" of "VUKA HOUSING") must not split it.
  let text = stripLiterals(stripLiterals(plainLetters(rawText), payees), trusted, "i")
  text = text.replace(/\S*\d\S*/g, " ").replace(ALLOWED_NEGATIONS, " ")
  for (const word of text.match(/[A-Za-z]+(?:['-][A-Za-z]+)*/g) ?? []) {
    const w = word.toLowerCase().replace(/'s$/, "")
    if (VOCABULARY.has(w)) continue
    if (w.includes("-") && w.split("-").every((part) => VOCABULARY.has(part))) continue
    return fail(`word outside the advisory vocabulary: "${word}"`)
  }
  return OK
}

/** Words that place one figure below or level with another: each a claim the facts must make, not the model. */
const BELOW_FAMILY = /\b(below|lower|less|under|within|smaller|fewer|short of|beneath)\b/i
const MATCH_FAMILY = /\b(match|matches|matched|matching|equal|equals|same as|in line|consistent|level with)\b/i
/** Where a rule's description starts: "the rule checks whether …", "this check compares …". */
const RULE_SENTENCE = /\b(the|this|its|that) (flag'?s? )?(rule|check)s? (checks?|compares?|looks? at|tests?|asks?)\b/i

/** The rules' own wording, where these words describe a rule, never a finding. */
const RULE_PHRASES = new RegExp([
  "within (the |a )?(\\d+(\\.\\d+)?% )?(match |amount |instalment match )?tolerance( of \\d+(\\.\\d+)?%)?",
  "(instalment |amount )?match tolerance", "within (the )?pay[- ]date window", "within \\d+ days",
  // The span may hold no other match-type word: one "match" per rule sentence, the rule's own.
  "checks? whether (?:(?!\\b(match\\w*|equal\\w*|same as|in line|consistent|level with)\\b)[^.;]){0,100}?\\bmatch(es)?\\b(?![^.;]*\\b(match(?! tolerance)\\w*|equal\\w*|same as|in line|consistent|level with)\\b)",
].join("|"), "gi")

/**
 * The reviewer's round-3 finding: "Betting is within the policy threshold",
 * "spend matches what was declared" contradict a raised flag in allowed words.
 * A below-type word is allowed only when the facts themselves say something is
 * below (`relations.below`); a match-type word only in the rules' own phrasing.
 */
export function checkRelations(rawText: string, allowed: Allowed): CheckResult {
  // The rules' phrasing is exempt only in a sentence about the rule ("the rule checks whether … within a 10% tolerance").
  // Only the rule's description: the words after "the rule checks / compares", in that sentence.
  const text = plainLetters(rawText).replace(ALLOWED_NEGATIONS, " ").split(/[.!?;]+/)
    .map((s) => {
      const m = RULE_SENTENCE.exec(s)
      return m ? s.slice(0, m.index) + s.slice(m.index).replace(RULE_PHRASES, " ") : s
    }).join(". ")
  const match = text.match(MATCH_FAMILY)
  if (match) return fail(`a match the facts do not state: "${match[0]}"`)
  const below = text.match(BELOW_FAMILY)
  if (below && !allowed.relations?.below) return fail(`a relation the facts do not state: "${below[0]}"`)
  return OK
}

/** Every language rule: reassurance and verdicts (they name the failure plainly), relations, then the vocabulary. */
export function checkLanguage(rawText: string, raisedFlagCodes: readonly string[], names: Iterable<string> = [], payees: Iterable<string> = [], allowed: Allowed = { amountsCents: [] }): CheckResult {
  const contradiction = checkNoContradiction(rawText, raisedFlagCodes)
  if (!contradiction.ok) return contradiction
  // Payees (client text) only as given, like the vocabulary; system names and codes in any case.
  const relations = checkRelations(stripLiterals(stripLiterals(norm(rawText), payees), [...names, ...raisedFlagCodes], "i"), allowed)
  if (!relations.ok) return relations
  return checkVocabulary(rawText, [...names, ...raisedFlagCodes], payees)
}

/** Which way a flag's figure departs from what was expected; null for flags that are presence, not size. */
export type Direction = "ABOVE" | "BELOW"

const ABOVE_WORDS = /\b(above|more than|exceed(s|ed|ing)?|higher than|greater than|larger than|older than)\b/i
const BELOW_WORDS = /\b(below|less than|lower than|smaller than|short of|under)\b/i
const NEGATION = /\b(not|never|no|none|cannot|can't|unable|fails?|failed|neither|nor|appears?|seems?|may|might|could|possibly|perhaps|unlikely|hardly|barely|rarely|seldom|scarcely|considered|said|deemed|arguably|allegedly)\b|n't\b/i
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

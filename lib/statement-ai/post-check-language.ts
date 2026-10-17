/**
 * Language lists. Code writes every sentence (render.ts), so these no longer
 * judge model prose: they withhold payee names that read as a reassurance or a
 * verdict (facts.ts safeKey), and re-check a stored output against today's
 * flags before it is shown (views.ts). Text is narrowed first: letters A-Z
 * only, invisible characters removed, whitespace collapsed.
 */
import { fail, norm, OK, stripLiterals, type CheckResult } from "./post-check-core"

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

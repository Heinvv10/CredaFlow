// The pure part of related-party screening for a remarketing sale: does the
// buyer equal, or appear in, any list a recovery must not sell to without a
// second approver? Loading the lists is the caller's job. The result carries
// kinds only, never a name or identifier: it is stored on the sale and written
// to the audit log.
//
// Identifiers (canonical form, mirrored by the SQL recoveryIdentifierKey):
//   NFKC, Unicode decimal digits as ASCII, everything but letters and digits
//   dropped, upper case. A CIPC registration number (YYYY/NNNNNN/NN) is further
//   reduced to YYYY + NNNNNN + the suffix as a number: the CK prefix and the
//   suffix's leading zero are insignificant, and when it is written with
//   separators its segments are read as written (the number zero-padded to 6). A buyer's identifier may carry a
//   label ("ID: ...", "Reg ..."): letters around an otherwise numeric key are dropped.
// Names: NFKD with the marks removed, lower case, apostrophes dropped, titles
//   (Mr, Mrs, Ms, Miss, Dr, Prof, Adv) and company words (Pty, Proprietary,
//   Ltd, Limited, CC, Inc, Trading, Trading as, T/A) dropped, name particles
//   (van der, de, du ...) joined to the word after them however they were
//   spaced, then compared as a SET of tokens (order does not matter), or as
//   the same letters run together. A natural person also matches probably on
//   surname plus first initial. Free text (a COI declaration) matches on the
//   buyer's tokens in order, as whole tokens.
// UNTESTED: the list of screened parties needs the lender's compliance sign-off.

export type ScreeningKind = "BORROWER" | "RELATED_PARTY" | "STAFF" | "COI_DECLARATION"

export interface ScreeningBuyer {
  name: string
  identifier: string
}

export interface ScreeningCandidates {
  kind: ScreeningKind
  names: string[]
  identifiers: string[]
  /** Names of natural persons, which also match probably on surname and first initial. */
  people?: string[]
  /** Free text (COI details): matches when it contains the buyer's name or identifier as whole tokens. */
  freeText?: string[]
}

export interface ScreeningMatch {
  kind: ScreeningKind
  on: "NAME" | "IDENTIFIER"
}

export interface ScreeningResult {
  match: boolean
  matches: ScreeningMatch[]
}

/** NFKC with every Unicode decimal digit as its ASCII digit. */
function fold(value: string): string {
  return value.normalize("NFKC").replace(/\p{Nd}/gu, (digit) => {
    let start = digit.codePointAt(0) as number
    const at = start
    while (start > 0 && at - (start - 1) < 10 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--
    return String((at - start) % 10)
  })
}

/** Letters and digits only, upper case (the digits ASCII). */
export function normaliseIdentifier(value: string): string {
  return fold(value).replace(/[^A-Za-z0-9]/g, "").toUpperCase()
}

const REGISTRATION = /^(?:CK)?(\d{4})(\d{6})(\d{1,2})$/
// A registration number written with separators (mirrored by the SQL recoveryIdentifierKey): an optional label or CK prefix,
// year, number (1 to 6 digits, zero-padded to 6), suffix (1 or 2 digits, a number), an optional trailing label. Its segments
// are read as written, so "2098/12345/05" and "2098/012345/05" are one number.
const REGISTRATION_WRITTEN = /^[^0-9A-Z]*(?:[A-Z]{1,8}[^0-9A-Z]*)?(\d{4})[^0-9A-Z]+(\d{1,6})[^0-9A-Z]+(\d{1,2})(?:[^0-9A-Z]*[A-Z]{1,8})?[^0-9A-Z]*$/

/** The identifier as screening compares it: a CIPC number written with separators in canonical form; else label letters dropped from a numeric key, a CIPC digit run in canonical form. */
export function canonicalIdentifier(value: string): string {
  const written = REGISTRATION_WRITTEN.exec(fold(value).replace(/[a-z]/g, (letter) => letter.toUpperCase()))
  if (written) return `${written[1]}${written[2].padStart(6, "0")}${Number(written[3])}`
  let key = normaliseIdentifier(value)
  const bare = key.replace(/^[A-Z]{1,8}(?=\d)/, "").replace(/(?<=\d)[A-Z]{1,8}$/, "")
  if (/^\d{6,}$/.test(bare)) key = bare
  const registration = REGISTRATION.exec(key)
  return registration ? `${registration[1]}${registration[2]}${Number(registration[3])}` : key
}

/** A letter that stands for a digit when typed among digits: O/o for 0, l/I for 1. */
const DIGIT_LOOKALIKES: Record<string, string> = { O: "0", L: "1", I: "1" }

/** The folded text, upper case (ASCII letters only), with O/l/I read as 0/1/1 inside every token made only of digits and those letters. */
function digitText(value: string): string {
  const upper = fold(value).replace(/[a-z]/g, (letter) => letter.toUpperCase())
  return upper.replace(/[0-9A-Z]+/g, (token) => (/^[0-9OLI]+$/.test(token) && /[0-9]/.test(token) ? token.replace(/[OLI]/g, (letter) => DIGIT_LOOKALIKES[letter]) : token))
}

/**
 * Everything a buyer's identifier field may hold, as keys to compare a known identifier against (mirrored by the SQL
 * recoveryIdentifierKeys, in the same order): its canonical identifier; each digit run, and all the digits together
 * (the label letters removed); every 13 digits of those (an SA ID inside a longer field: two IDs, an appended digit,
 * a "27" prefix, a label in the middle); every 11 or 12 digits as a registration number; and each registration number
 * written with separators anywhere in it. A known identifier matches when its canonical form is one of the keys.
 */
export function identifierKeys(value: string): string[] {
  const keys = new Set<string>()
  const canonical = canonicalIdentifier(value)
  if (canonical !== "") keys.add(canonical)
  const text = digitText(value)
  const sources = [...(text.match(/[0-9]+/g) ?? []), text.replace(/[^0-9]/g, "")]
  for (const source of sources) {
    if (source === "") continue
    keys.add(source)
    for (let at = 0; at + 13 <= source.length; at++) keys.add(source.slice(at, at + 13))
    for (const length of [11, 12]) {
      for (let at = 0; at + length <= source.length; at++) {
        const window = source.slice(at, at + length)
        keys.add(`${window.slice(0, 4)}${window.slice(4, 10)}${Number(window.slice(10))}`)
      }
    }
  }
  for (const written of text.matchAll(/(\d{4})[^0-9A-Z]+(\d{1,6})[^0-9A-Z]+(\d{1,2})/g)) keys.add(`${written[1]}${written[2].padStart(6, "0")}${Number(written[3])}`)
  return [...keys].sort()
}

/** Latin look-alikes of the Cyrillic and Greek letters people use to spell a name past a comparison. */
const CONFUSABLES: Record<string, string> = Object.fromEntries([
  ..."аАеЕоОрРсСуУхХіІјЈѕЅһНВКМТ".split("").map((c, i) => [c, "aAeEoOpPcCyYxXiIjJsShHBKMT"[i]]),
  ..."αΑβΒεΕζΖηΗιΙκΚμΜνΝοΟρΡτΤυΥχΧωΩ".split("").map((c, i) => [c, "aAbBeEzZhHiIkKmMnNoOpPtTuUxXwW"[i]]),
])
const foldConfusables = (value: string) => value.replace(/[\u0370-\u03ff\u0400-\u052f]/g, (c) => CONFUSABLES[c] ?? c)

const TITLES = new Set(["mr", "mrs", "ms", "miss", "dr", "prof", "adv"])
const COMPANY_WORDS = new Set(["pty", "proprietary", "ltd", "limited", "cc", "inc", "incorporated", "trading"])
const PARTICLES = new Set(["van", "der", "den", "de", "du", "von", "le", "la", "ten", "ter", "te", "vander", "vanden", "vande"])

function words(value: string): string[] {
  return foldConfusables(fold(value)).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/['’`´]/g, "").replace(/\bt\/a\b/g, " ").split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "")
}

/** The tokens of a name once titles and company words are gone and particles are joined to the word after them. */
export function nameTokens(value: string): string[] {
  const kept = words(value).filter((word, i, all) => !TITLES.has(word) && !COMPANY_WORDS.has(word) && !(word === "as" && all[i - 1] === "trading"))
  const tokens: string[] = []
  let prefix = ""
  for (const word of kept) {
    if (PARTICLES.has(word)) {
      prefix += word
      continue
    }
    tokens.push(prefix + word)
    prefix = ""
  }
  if (prefix !== "") tokens.push(prefix)
  return tokens
}

const sortedKey = (tokens: string[]) => [...tokens].sort().join(" ")

function sameName(buyer: string[], candidate: string[]): boolean {
  if (buyer.length === 0 || candidate.length === 0) return false
  return sortedKey(buyer) === sortedKey(candidate) || buyer.join("") === candidate.join("")
}

/** A natural person's initial and surname, or first name and surname, run together with no space, is a token of the buyer's name. */
function joinedPerson(buyer: string[], person: string[]): boolean {
  if (person.length < 2) return false
  const first = person[0]
  const surname = person[person.length - 1]
  const forms = new Set([`${first[0]}${surname}`, `${first}${surname}`, `${surname}${first[0]}`, `${surname}${first}`])
  return buyer.some((token) => forms.has(token))
}

/** A natural person's surname (the last word) and first initial both appear in the buyer's name. */
function probablyPerson(buyer: string[], person: string[]): boolean {
  if (buyer.length < 2 || person.length < 2) return false
  const surname = person[person.length - 1]
  const at = buyer.indexOf(surname)
  if (at < 0) return false
  const initial = person[0][0]
  return buyer.some((token, i) => i !== at && token.startsWith(initial))
}

/** Whether `needle` occurs in `haystack` as a run of whole tokens. */
function containsTokens(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return false
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((token, offset) => haystack[start + offset] === token)) return true
  }
  return false
}

/** Whether a run of whole words concatenates to the identifier (a registration number split by slashes or spaces). */
function containsIdentifier(haystack: string[], identifier: string): boolean {
  if (identifier === "") return false
  for (let start = 0; start < haystack.length; start++) {
    let joined = ""
    for (let end = start; end < haystack.length && joined.length < identifier.length + 3; end++) {
      joined += haystack[end]
      // run together, or with the words as separators (a registration number's segments keep their padding)
      if (canonicalIdentifier(joined) === identifier || canonicalIdentifier(haystack.slice(start, end + 1).join(" ")) === identifier) return true
    }
  }
  return false
}

export function screenBuyer(buyer: ScreeningBuyer, candidates: ScreeningCandidates[]): ScreeningResult {
  const name = nameTokens(buyer.name)
  const identifier = canonicalIdentifier(buyer.identifier)
  const keys = new Set(identifierKeys(buyer.identifier))
  const matches: ScreeningMatch[] = []
  for (const candidate of candidates) {
    const people = new Set(candidate.people ?? [])
    for (const candidateName of candidate.names) {
      const tokens = nameTokens(candidateName)
      if (sameName(name, tokens) || (people.has(candidateName) && (probablyPerson(name, tokens) || joinedPerson(name, tokens)))) matches.push({ kind: candidate.kind, on: "NAME" })
    }
    for (const candidateIdentifier of candidate.identifiers) {
      const known = canonicalIdentifier(candidateIdentifier)
      if (known !== "" && keys.has(known)) matches.push({ kind: candidate.kind, on: "IDENTIFIER" })
    }
    for (const text of candidate.freeText ?? []) {
      if (containsTokens(nameTokens(text), name)) matches.push({ kind: candidate.kind, on: "NAME" })
      if (containsIdentifier(words(text), identifier)) matches.push({ kind: candidate.kind, on: "IDENTIFIER" })
    }
  }
  return { match: matches.length > 0, matches }
}

/**
 * Does the name on a document belong to the person on the client record?
 *
 * Split out of `documentValidationService.ts`, which had grown past the 300-line
 * limit in CLAUDE.md. This is a self-contained pure function with no Prisma or
 * validation-result plumbing, and it is the file the tests in
 * `name-matching.test.ts` are named for.
 */

function normalizeString(value: string | null | undefined): string {
  if (!value) return ''
  return value.toLowerCase().trim().replace(/\s+/g, ' ')
}

/** Courtesy titles dropped before comparison. `ms` is deliberately absent —
 *  see `stripTitle`. */
const NAME_TITLES = new Set([
  'mr', 'mrs', 'miss', 'dr', 'prof', 'adv', 'rev', 'sir', 'mnr', 'mev', 'mej',
])

/** A token is read as initials only if it is one or two letters. Three would
 *  swallow real given names — Sam, Ben, Amy — and match them to any surname-mate
 *  whose given name starts with an S, B or A. A three-initial run is rarer than
 *  a three-letter first name, so it loses the tie. */
const MAX_INITIALS_TOKEN_LENGTH = 2

function nameTokens(name: string | null | undefined): string[] {
  if (!name) return []
  return normalizeString(name)
    // Fold diacritics FIRST. Deleting them instead turns "müller" into
    // "mller", which then matches no spelling of Muller at all — a client with
    // an accent in their surname became unmatchable, while the bank statement
    // spelled it plainly. Decompose, then drop the combining marks, so ü -> u.
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    // Hyphens and apostrophes are REMOVED, not turned into separators, so
    // "Ben-Ali" and "Radebe-Nkosi" collapse to one token. A document and a
    // record routinely disagree about the hyphen — one prints "Karim Ben Ali",
    // the other records "Karim Ben-Ali" — and a separator would make those two
    // spellings of one surname compare unequal. Removing it lets the
    // adjacent-run join in `takeSurname` reconcile them.
    .replace(/['\u2019\-]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Drop a leading courtesy title, but only when two tokens survive it.
 *
 * "Ms Radebe" is genuinely ambiguous — a title, or the initials M and S. With
 * only two tokens the reading cannot be settled, so the token is KEPT and read
 * as initials; `Ms Radebe` then still matches Mbali Radebe through the initials
 * path, and the ambiguity costs nothing. "Mr MS Radebe" has three tokens, so
 * the title reading is unambiguous and `mr` goes.
 */
function stripTitle(tokens: string[]): string[] {
  // Loops: "Mr Dr J Ndlovu" carries two. Stripping only the first left "dr"
  // among the given names, where it turned the initials run "j" into "dj" and
  // refused James Ndlovu — a false reject caused entirely by a courtesy title.
  let out = tokens
  while (out.length >= 3 && NAME_TITLES.has(out[0])) out = out.slice(1)
  return out
}

/**
 * Nobiliary and patronymic particles that belong to the surname, not to the
 * given names. Afrikaans and Dutch surnames make these common here.
 */
const SURNAME_PARTICLES = new Set([
  'van', 'von', 'der', 'den', 'de', 'du', 'le', 'la', 'ten', 'ter',
  'di', 'da', 'dos', 'del', 'bin', 'bint', 'binte', 'ibn', 'el', 'al',
])

/**
 * Split a client record into surname and given names.
 *
 * The record is `firstName + " " + lastName`, so the surname is the LAST token
 * — except when it carries a particle. "Jan Hendrik Van Mocktest" has lastName
 * "Van Mocktest"; taking only "mocktest" leaves "van" sitting among the given
 * names, where it matched the "van" on any other Van Mocktest's statement and
 * carried the comparison by itself. That let SIPHO VAN MOCKTEST pass for Jan
 * Hendrik Van Mocktest — a false accept on the identity of a payout.
 *
 * The surname is returned WITHOUT spaces so it can be compared against a
 * document that may print it either joined or split.
 */
function shortestRecordSurnameStart(tokens: string[]): number {
  let start = tokens.length - 1
  // Never consume every token: a record must keep at least one given name, or
  // there is nothing left to corroborate the surname with. That floor is the
  // load-bearing part — mutating it to `start > 0` fails a test. Its exact
  // value above 1 is NOT: `recordSurnameReadings` goes on to try longer
  // surnames anyway, so a floor of 2 produces the same answers. The particle
  // list still earns its place by making the FIRST reading the right one.
  while (start > 1 && SURNAME_PARTICLES.has(tokens[start - 1])) start--
  return start
}

/**
 * Every reading of the record's surname, shortest first, as
 * `{ surname, givens }`.
 *
 * A `lastName` of two words does not always announce itself with a known
 * particle — "Ben Ali" is a surname, "Ben" is also a common given name, so a
 * particle list cannot settle it without misreading someone's middle name. The
 * readings are therefore tried in turn and the first that the document
 * corroborates wins.
 *
 * Crucially the sequence STARTS at the particle boundary and only grows from
 * there. Trying shorter readings too would hand back the false accept that
 * `SURNAME_PARTICLES` exists to prevent: with surname "mocktest", the leftover
 * "van" matches the "van" on any other Van Mocktest's statement by itself.
 * Growing the surname only ever makes the requirement more specific.
 */
function recordSurnameReadings(tokens: string[]): { surname: string; givens: string[] }[] {
  const readings: { surname: string; givens: string[] }[] = []
  for (let start = shortestRecordSurnameStart(tokens); start >= 1; start--) {
    readings.push({ surname: tokens.slice(start).join(''), givens: tokens.slice(0, start) })
  }
  return readings
}

/**
 * Find the recorded surname among the document's tokens and remove it,
 * returning what is left. Null when the surname is not there at all.
 *
 * The surname is NOT assumed to be last. The commonest failing shape of extracted
 * holder names puts it in the middle — "MNR JOHANNES H TESTER HERMANUS" for
 * Johannes Hermanus Tester — and a last-token rule raises a false mismatch. Position carries no
 * information here; presence does.
 *
 * The adjacent-run fallback exists because OCR splits surnames: "MR AMOS MOCK
 * ERY" is Amos Mockery, cut mid-word by the extractor.
 */
function takeSurname(tokens: string[], surname: string): string[] | null {
  for (let start = 0; start < tokens.length; start++) {
    let joined = ''
    for (let end = start; end < tokens.length; end++) {
      joined += tokens[end]
      if (joined.length > surname.length) break
      if (joined === surname) return [...tokens.slice(0, start), ...tokens.slice(end + 1)]
    }
  }
  return null
}

/**
 * The surname must be present — it is the only part both sides always spell in
 * full, so it carries the identity. Whatever remains must then corroborate the
 * recorded given names, either spelled out or as initials.
 */
function namesMatch(statement: string[], record: string[]): boolean {
  if (statement.length < 2 || record.length < 2) return false
  return recordSurnameReadings(record).some(r => matchesReading(statement, r))
}

function matchesReading(
  statement: string[],
  { surname, givens: recordGivens }: { surname: string; givens: string[] },
): boolean {
  if (recordGivens.length === 0) return false

  const statementGivens = takeSurname(statement, surname)
  if (statementGivens === null || statementGivens.length === 0) return false

  // Written-out given names — "Mbali Sthembile Radebe" against "Mbali Radebe".
  //
  // The substring arm needs a length floor on BOTH sides. Without it a lone
  // initial matches any name containing that letter — "S" against "Sipho" — so
  // "M S Radebe" passed for Sipho Radebe, which is the very confusion the
  // initials path below exists to adjudicate.
  // Corroboration must come from the record's FIRST given name, not from any
  // leftover token.
  //
  // The record is `firstName + " " + lastName`, so token 0 is certainly a given
  // name — everything after it may be a fragment of a two-word surname. When
  // ANY leftover could carry the match, a surname fragment matched itself:
  // "THABO BEN ALI" passed for Karim Ben Ali on the shared "ben", exactly as
  // "SIPHO VAN MOCKTEST" passed on the shared "van". `SURNAME_PARTICLES` fixes
  // that only for particles it knows, and "Ben" cannot be added to it — it is
  // also an ordinary given name.
  const firstGiven = recordGivens[0]
  const named = statementGivens.filter(s => s.length > MAX_INITIALS_TOKEN_LENGTH)
  // The length floor applies to the DOCUMENT side only. It exists to stop a
  // lone initial matching inside a name — "S" against "Sipho" — and that is a
  // property of what the statement printed, not of the record. `firstName` is a
  // real name field, and short first names are real: Jo, Bo, Al, Cy. Requiring
  // the floor on both sides made the comparison asymmetric, so a client
  // recorded as "Jo Nkosi" could never match a statement reading "John Nkosi".
  const spelledOut = statementGivens.some(s =>
    s === firstGiven
    // PREFIX, not containment. `includes` accepted any name that merely
    // CONTAINED the other, so "Ann Botha" passed for Hannah Botha, "Man Chen"
    // for Amanda Chen and "Ona Naidoo" for Leona Naidoo — different people
    // sharing a surname, which is the payout fraud this comparison exists to
    // stop. Names abbreviate from the front, so a shortening is a prefix;
    // a fragment from the middle is somebody else.
    || (s.length > MAX_INITIALS_TOKEN_LENGTH
      && (s.startsWith(firstGiven) || firstGiven.startsWith(s)))
  )
  if (spelledOut) return true

  // A statement that SPELLED OUT a given name and still did not match has
  // contradicted the record; it must not then be re-read as initials. Reducing
  // "Sam" to "S" and accepting it against Sipho Ambrose Mallory discards the
  // very evidence that says these are different people. The initials path is
  // for statements that only ever offered initials.
  if (named.length > 0) return false

  // EVERY leftover token contributes its initial — a spelled-out given name
  // that failed to match above is evidence AGAINST the person, not a token to
  // discard. Dropping it would let "Sipho B Mallory" pass for Bella Beatrix
  // Mallory on the strength of the lone "B".
  //
  // "M S" and "MS" are the same claim, so a short token expands to its letters
  // and a spelled-out name contributes only its first.
  const statementInitials = statementGivens
    .map(g => (g.length <= MAX_INITIALS_TOKEN_LENGTH ? g : g[0]))
    .join('')
  const recordInitials = recordGivens.map(r => r[0]).join('')

  // The record may know FEWER given names than the document shows, so the
  // record's initials being a prefix of the document's is missing information
  // rather than a contradiction.
  //
  // The reverse is NOT safe. `statementInitials.startsWith(recordInitials)`
  // accepts any document initials that merely BEGIN with the record's, and the
  // record contributes a single initial whenever `firstName` is one word — so
  // "AL AMIN" was accepted for Ahmed Amin, two different first names sharing a
  // letter. In the payout direction that is exactly the wrong answer, and no
  // real repair needs it: genuine repairs match the initials exactly.
  if (statementInitials === recordInitials) return true
  if (recordInitials.startsWith(statementInitials)) return true

  // A two-letter token is genuinely ambiguous — an initials run (M then S) or
  // an abbreviated first name (Bo for Bongani). Having ruled out the initials
  // reading, try the abbreviation: the recorded first name must actually start
  // with it. "bongani" does start with "bo"; "ahmed" does not start with "al".
  // One letter is not tried, because a single initial is unambiguously an
  // initial and is already covered above.
  const lead = statementGivens[0]
  return lead.length === MAX_INITIALS_TOKEN_LENGTH && firstGiven.startsWith(lead)
}

/**
 * Is the name on a document the same person as the name on the client record?
 *
 * Handles the formats SA bank statements print: "MS Radebe", "M S Radebe",
 * "M.S. Radebe", "MR MS RADEBE" and the surname-first "RADEBE MS".
 *
 * The previous implementation compared bags of tokens after dropping every
 * single-character token, which broke in both directions at once: SPACED
 * initials disappeared so the surname alone carried the match — every Radebe
 * matched every other Radebe — while CONCATENATED initials survived as a token
 * matching nothing and sank the comparison. Concatenated is the commoner format
 * here, so the commoner format was the failing one.
 */
export function areNamesSimilar(
  /** The name as printed on the scanned document. */
  documentName: string | null,
  /** The client record, always `firstName + " " + lastName`. */
  recordName: string | null,
): boolean {
  const statement = stripTitle(nameTokens(documentName))
  const record = stripTitle(nameTokens(recordName))
  if (statement.length === 0 || record.length === 0) return false

  return namesMatch(statement, record)
}

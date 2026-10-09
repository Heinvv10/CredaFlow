// The account-holder / ID name matcher, against the formats South African
// bank statements and ID documents actually print.
//
// WHY THIS EXISTS. `areNamesSimilar` had no test of its own. It compared bags
// of tokens, having first dropped every token of length 1 — so SPACED initials
// ("M S Radebe") vanished and the surname alone carried the match, while
// CONCATENATED initials ("MS Radebe") survived as a token matching nothing and
// sank it. Concatenated is the commoner format on SA statements, so the
// commoner format was the one that failed.
//
// Both halves were wrong in opposite directions, which is why this file asserts
// the REFUSALS as hard as the matches. Loosening the concatenated case without
// tightening the spaced one would make "M S Radebe" match every other Radebe.

import { describe, it, expect } from "vitest"
import { areNamesSimilar } from "@/lib/ocr/name-matching"

describe("areNamesSimilar — initials as printed on a bank statement", () => {
  // The record side is always `firstName + " " + lastName` at every call site,
  // so it carries ONE given name. A statement showing two initials is therefore
  // routinely more specific than the record, and the extra initial must be
  // tolerated rather than treated as a contradiction.
  it("refuses a second initial the record cannot corroborate", () => {
    // The document claims initials M and S; the record knows only "Mbali". The
    // second initial is unverifiable, and accepting it is indistinguishable
    // from accepting "AL AMIN" for Ahmed Amin — two different first names
    // sharing a letter. A blind reviewer proved that false accept; this is the
    // same shape, so it refuses too. No pair in the production corpus needs it:
    // every real repair matches the initials exactly.
    expect(areNamesSimilar("MS Radebe", "Mbali Radebe")).toBe(false)
    expect(areNamesSimilar("AL AMIN", "Ahmed Amin")).toBe(false)
  })

  it("matches when the record corroborates every initial", () => {
    expect(areNamesSimilar("MS Radebe", "Mbali Sthembile Radebe")).toBe(true)
    expect(areNamesSimilar("MS RADEBE", "MBALI STHEMBILE RADEBE")).toBe(true)
  })

  it("matches a two-letter token that abbreviates the recorded first name", () => {
    // The other reading of a two-letter token. "Bo" is not the initials B and
    // O — it is short for Bongani, and the record proves it by starting with
    // those letters. "Al" against "Ahmed" does not, which is what separates
    // this from the refusal above.
    expect(areNamesSimilar("Bo Nkosi", "Bongani Nkosi")).toBe(true)
    expect(areNamesSimilar("Jo Nkosi", "Josephine Nkosi")).toBe(true)
    expect(areNamesSimilar("Cy Nkosi", "Sipho Nkosi")).toBe(false)
  })

  it("matches concatenated initials against full given names", () => {
    expect(areNamesSimilar("MS Radebe", "Mbali Sthembile Radebe")).toBe(true)
    expect(areNamesSimilar("TM Nkosi", "Thabo Mandla Nkosi")).toBe(true)
  })

  it("matches spaced and dotted initials", () => {
    expect(areNamesSimilar("M S Radebe", "Mbali Sthembile Radebe")).toBe(true)
    expect(areNamesSimilar("M.S. Radebe", "Mbali Sthembile Radebe")).toBe(true)
    expect(areNamesSimilar("T Nkosi", "Thabo Nkosi")).toBe(true)
  })

  it("ignores a leading title", () => {
    expect(areNamesSimilar("Mr MS Radebe", "Mbali Sthembile Radebe")).toBe(true)
    expect(areNamesSimilar("MRS T Nkosi", "Thabo Nkosi")).toBe(true)
  })

  it("refuses a title-plus-surname document, which names no given name at all", () => {
    // "Ms Radebe" is ambiguous: a courtesy title, or the initials M and S.
    // BOTH readings fail to identify a person. As a title it offers no given
    // name, and a surname alone is not evidence of who holds the account; as
    // initials the record corroborates only the M. Same answer either way.
    expect(areNamesSimilar("Ms Radebe", "Mbali Radebe")).toBe(false)
    // With the middle name on record, the initials reading does corroborate.
    expect(areNamesSimilar("Ms Radebe", "Mbali Sthembile Radebe")).toBe(true)
  })

  it("matches ordinary full names, including a middle name the record lacks", () => {
    expect(areNamesSimilar("Mbali Radebe", "Mbali Radebe")).toBe(true)
    expect(areNamesSimilar("Mbali Sthembile Radebe", "Mbali Radebe")).toBe(true)
  })

  it("matches when the statement prints the surname first", () => {
    // "RADEBE MS" is a common statement layout. The surname is found wherever
    // it sits, so the given-name rules then apply unchanged — including the
    // refusal of an initial the record cannot corroborate.
    expect(areNamesSimilar("RADEBE MS", "Mbali Sthembile Radebe")).toBe(true)
    expect(areNamesSimilar("Radebe Mbali", "Mbali Radebe")).toBe(true)
    expect(areNamesSimilar("RADEBE MS", "Mbali Radebe")).toBe(false)
  })
})

// Shapes taken from 99 real extracted `accountHolder` values on production
// (2026-08-17), with the names substituted — the STRUCTURE is the evidence, the
// clients are not. A first attempt at this fix assumed the surname was the last
// token; measured against that corpus it repaired 5 false warnings and created
// 13 new ones, all of them these shapes.
describe("areNamesSimilar — shapes the extractor actually produces", () => {
  it("finds a surname buried mid-string", () => {
    // The commonest failing shape on production: given, initial, SURNAME, given.
    expect(areNamesSimilar("MNR THABO M NKOSI MANDLA", "Thabo Mandla Nkosi")).toBe(true)
    expect(areNamesSimilar("MR SIPHO R DLAMINI ROLAND", "SIPHO ROLAND DLAMINI")).toBe(true)
  })

  it("rejoins a surname the extractor split in two", () => {
    // "MR AMOS MOCK ERY" is Amos Mockery, cut mid-word by the VLM.
    expect(areNamesSimilar("MR AMOS MOCK ERY", "Amos Mockery")).toBe(true)
  })

  it("still refuses a company account held by a client", () => {
    // Real case: a business account on a personal client's file. The surname is
    // simply absent, and no amount of token overlap should rescue it.
    expect(areNamesSimilar("ACME WIDGETS PTY LTD", "Jan Hendrik Van Mocktest")).toBe(false)
  })

  it("does not let a mid-string surname excuse a wrong given name", () => {
    // A shared MIDDLE name is not enough when the first names disagree. The
    // statement says the holder is Sipho; the record says Thabo. Heading toward
    // a payout gate, that is a person to look at, not a person to wave through.
    expect(areNamesSimilar("MNR SIPHO M NKOSI MANDLA", "Thabo Mandla Nkosi")).toBe(false)
    expect(areNamesSimilar("MNR SIPHO B NKOSI BONGANI", "Thabo Mandla Nkosi")).toBe(false)
    // The right first name still matches through the same shape.
    expect(areNamesSimilar("MNR THABO M NKOSI MANDLA", "Thabo Mandla Nkosi")).toBe(true)
  })
})

describe("areNamesSimilar — refusals", () => {
  it("refuses a different person entirely", () => {
    expect(areNamesSimilar("Mbali Radebe", "Sipho Dlamini")).toBe(false)
  })

  it("refuses a different person who shares the surname", () => {
    // THE DEFECT THE LOOSE HALF CREATED. Under the old matcher the spaced form
    // dropped both initials and matched on "radebe" alone, so this returned
    // true — any Radebe's statement passed for any other Radebe.
    expect(areNamesSimilar("M S Radebe", "Sipho Radebe")).toBe(false)
    expect(areNamesSimilar("MS Radebe", "Sipho Radebe")).toBe(false)
    expect(areNamesSimilar("T Nkosi", "Bongani Nkosi")).toBe(false)
  })

  it("refuses initials that contradict the recorded given name", () => {
    expect(areNamesSimilar("SD Radebe", "Mbali Radebe")).toBe(false)
  })

  it("refuses a surname-only statement, which is not evidence of a person", () => {
    expect(areNamesSimilar("Radebe", "Mbali Radebe")).toBe(false)
  })

  it("refuses when the surname differs even if the given name matches", () => {
    expect(areNamesSimilar("Mbali Dlamini", "Mbali Radebe")).toBe(false)
  })

  it("refuses empty and absent input", () => {
    expect(areNamesSimilar(null, "Mbali Radebe")).toBe(false)
    expect(areNamesSimilar("Mbali Radebe", null)).toBe(false)
    expect(areNamesSimilar("", "Mbali Radebe")).toBe(false)
    expect(areNamesSimilar("   ", "Mbali Radebe")).toBe(false)
    expect(areNamesSimilar("Mr", "Mbali Radebe")).toBe(false)
  })
})

describe("areNamesSimilar — a spelled-out given name is evidence, not noise", () => {
  it("refuses when a spelled-out given name contradicts, even if an initial fits", () => {
    // Found while measuring blast radius. An earlier draft built the initials
    // run from the SHORT leftovers only, so "Sipho" was discarded and the lone
    // "B" carried the match. The wrong person passed on one letter.
    expect(areNamesSimilar("SIPHO B MALLORY", "Bella Beatrix Mallory")).toBe(false)
  })

  it("refuses a misspelled given name rather than guessing", () => {
    // Real production pair (names substituted) whose two records differ by one
    // letter. An earlier draft matched it with an edit-distance-1 rule; a blind
    // reviewer showed that same rule accepts Ayanda for Amanda, Asanda for
    // Amanda, Noma for Nomsa and Bonani for Bongani — common, distinct SA names
    // one edit apart. Buying one typo at the price of four wrong people is a
    // bad trade at a payout gate, so the rule is gone and this pair goes back
    // to being a warning a human reads.
    expect(areNamesSimilar("MISS BELA B MALLORY", "BELLA BEATRIX MALLORY")).toBe(false)
    expect(areNamesSimilar("Ayanda Dlamini", "Amanda Dlamini")).toBe(false)
    expect(areNamesSimilar("Noma Dlamini", "Nomsa Dlamini")).toBe(false)
  })
})

describe("areNamesSimilar — surnames carrying a particle", () => {
  // FOUND BY PROBING, not by the production corpus — the one particled surname in it
  // happened to be the right person, so measurement alone would have shipped
  // this. `lastName` is "Van Mocktest", so treating only the final token as the
  // surname left "van" among the given names, where it matched the "van" on any
  // other Van Mocktest's statement and carried the comparison single-handed.
  it("refuses a different person sharing a particled surname", () => {
    expect(areNamesSimilar("SIPHO VAN MOCKTEST", "Jan Hendrik Van Mocktest")).toBe(false)
    expect(areNamesSimilar("THABO DU PLESSIS", "Marie Du Plessis")).toBe(false)
    expect(areNamesSimilar("X DE WET", "Johannes De Wet")).toBe(false)
  })

  it("still matches the right person with a particled surname", () => {
    expect(areNamesSimilar("JAN HENDRIK VAN MOCKTEST", "Jan Hendrik Van Mocktest")).toBe(true)
    expect(areNamesSimilar("J H VAN MOCKTEST", "Jan Hendrik Van Mocktest")).toBe(true)
    expect(areNamesSimilar("M DU PLESSIS", "Marie Du Plessis")).toBe(true)
    expect(areNamesSimilar("J DE WET", "Johannes De Wet")).toBe(true)
  })

  it("matches a particled surname the document printed joined up", () => {
    expect(areNamesSimilar("MNR JH VANMOCKTEST", "Jan Hendrik Van Mocktest")).toBe(true)
  })
})

describe("areNamesSimilar — accented and unreadable names", () => {
  // The tokenizer stripped everything outside [a-z], so "müller" became
  // "mller" and matched no spelling of Muller. The client was unmatchable
  // against a statement that spelled the name plainly.
  it("treats an accented name and its plain spelling as the same name", () => {
    expect(areNamesSimilar("HANS MULLER", "Hans Müller")).toBe(true)
    expect(areNamesSimilar("H MULLER", "Hans Müller")).toBe(true)
    expect(areNamesSimilar("HANS MÜLLER", "Hans Muller")).toBe(true)
    expect(areNamesSimilar("RENE DU TOIT", "René Du Toit")).toBe(true)
  })

  it("does not let diacritic folding match a different person", () => {
    expect(areNamesSimilar("SIPHO MULLER", "Hans Müller")).toBe(false)
  })

  it("refuses a name it cannot read at all", () => {
    // Non-Latin script reduces to no tokens. Refusing is correct: a comparison
    // that cannot read the name must not claim a match.
    expect(areNamesSimilar("محمد", "Hans Müller")).toBe(false)
    expect(areNamesSimilar("...", "Hans Müller")).toBe(false)
  })
})

describe("areNamesSimilar — a two-word surname without a known particle", () => {
  // "Ben Ali" is a surname; "Ben" is also an ordinary given name, so it cannot
  // go in SURNAME_PARTICLES. Reported by a blind reviewer as a hyphen
  // regression, and probing it found the same false-accept shape underneath.
  it("refuses a different person sharing a two-word surname", () => {
    expect(areNamesSimilar("THABO BEN ALI", "Karim Ben Ali")).toBe(false)
    expect(areNamesSimilar("THABO BEN-ALI", "Karim Ben-Ali")).toBe(false)
  })

  it("agrees about a surname whichever side spells it with the hyphen", () => {
    expect(areNamesSimilar("Karim Ben Ali", "Karim Ben-Ali")).toBe(true)
    expect(areNamesSimilar("Karim Ben-Ali", "Karim Ben Ali")).toBe(true)
    expect(areNamesSimilar("S RADEBE NKOSI", "Sipho Radebe-Nkosi")).toBe(true)
    expect(areNamesSimilar("S OBRIEN", "Sean O'Brien")).toBe(true)
  })

  it("strips more than one courtesy title", () => {
    // Two titles left "dr" among the given names, turning the initials run "j"
    // into "dj" and refusing James Ndlovu — a false reject caused by a title.
    expect(areNamesSimilar("Mr Dr J Ndlovu", "James Ndlovu")).toBe(true)
  })
})

describe("areNamesSimilar — the initials-token boundary is pinned", () => {
  // A blind reviewer mutated MAX_INITIALS_TOKEN_LENGTH from 2 to 3 and the
  // whole suite still passed. The constant is the control here: at 3, a
  // three-letter given name is read as a run of initials and matches any
  // surname-mate whose names begin with those letters.
  it("reads a two-letter token as initials", () => {
    expect(areNamesSimilar("MS Radebe", "Mbali Sthembile Radebe")).toBe(true)
  })

  it("does NOT read a three-letter given name as initials", () => {
    // At MAX_INITIALS_TOKEN_LENGTH = 3 this returns true: "sam" would collapse
    // to the initials S, A, M and match Sipho Ambrose Mallory.
    expect(areNamesSimilar("Sam Mallory", "Sipho Ambrose Mallory")).toBe(false)
    expect(areNamesSimilar("Ben Nkosi", "Bongani Elias Nkosi")).toBe(false)
  })
})

describe("areNamesSimilar — a short recorded first name is a name, not an initial", () => {
  // The document is the FIRST argument at all three call sites and the client
  // record the second, so the length floor belongs on the document side alone.
  // Applying it to both made the comparison asymmetric: a client recorded as
  // "Jo Nkosi" could never match a statement reading "John Nkosi", while the
  // reverse matched. Jo, Bo, Al and Cy are real first names.
  it("matches a spelled-out document name against a short recorded one", () => {
    expect(areNamesSimilar("John Nkosi", "Jo Nkosi")).toBe(true)
    expect(areNamesSimilar("Joseph Amin", "Jo Amin")).toBe(true)
    expect(areNamesSimilar("Bongani Nkosi", "Bo Nkosi")).toBe(true)
  })

  it("does not let a short recorded name match just any first name", () => {
    // Reported by a blind reviewer as a false accept at an earlier commit.
    expect(areNamesSimilar("Ahmed Amin", "Al Amin")).toBe(false)
    expect(areNamesSimilar("Fatima Karim", "Al Karim")).toBe(false)
  })

  it("still refuses a lone initial matching inside a name", () => {
    // The floor's actual job, unchanged: "S" must not match "Sipho".
    expect(areNamesSimilar("M S Radebe", "Sipho Radebe")).toBe(false)
  })
})

describe("areNamesSimilar — the particle floor keeps one given name", () => {
  // Pins the `start > 1` boundary a blind reviewer found unpinned. A record of
  // firstName "Van" + lastName "Der Merwe" is all particles until the last
  // token; consuming one too many leaves no given name at all and the record
  // can never match anything.
  it("matches a record whose first name is itself a particle word", () => {
    expect(areNamesSimilar("VAN DER MERWE", "Van Der Merwe")).toBe(true)
    expect(areNamesSimilar("V DER MERWE", "Van Der Merwe")).toBe(true)
  })

  it("still refuses a different person with that surname", () => {
    expect(areNamesSimilar("THABO DER MERWE", "Van Der Merwe")).toBe(false)
  })
})

describe("areNamesSimilar — a name shortens from the front, not the middle", () => {
  // Proven by an adversarial reviewer. The containment test
  // (`s.includes(firstGiven) || firstGiven.includes(s)`) accepted any given
  // name that merely CONTAINED the other, so two different people sharing a
  // surname matched — the exact shape of the fraud this comparison exists to
  // stop: submit a statement for an account you really hold, against a
  // victim whose recorded first name is a substring of yours.
  it("refuses a given name that only appears INSIDE the recorded one", () => {
    expect(areNamesSimilar("Ann Botha", "Hannah Botha")).toBe(false)
    expect(areNamesSimilar("Man Chen", "Amanda Chen")).toBe(false)
    expect(areNamesSimilar("Ona Naidoo", "Leona Naidoo")).toBe(false)
  })

  it("still accepts a name shortened from the front", () => {
    // Abbreviations are prefixes, and the record proves the prefix.
    expect(areNamesSimilar("Johan Tester", "Johannes Tester")).toBe(true)
    expect(areNamesSimilar("Johannes Tester", "Johan Tester")).toBe(true)
  })

  it("refuses a first name that merely starts similarly", () => {
    expect(areNamesSimilar("Leandra Smith", "Lee Smith")).toBe(false)
  })
})

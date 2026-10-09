import { describe, it, expect } from "vitest"
import {
  leadDedupKeys,
  duplicateReasons,
  findDuplicateLeads,
  describeReasons,
  applyCandidateCap,
  countDuplicatesByPhone,
} from "@/lib/crm/lead-dedup"

// Expected keys are written as LITERALS throughout. Deriving them from
// normalisePhone/normaliseEmail — the same functions the code under test calls
// — would make every assertion here true by construction: the rule could
// return anything at all and the test would still pass.

describe("leadDedupKeys", () => {
  it("normalises an SA local phone to E.164 digits", () => {
    expect(leadDedupKeys({ phone: "0820000574", email: null }).phone).toBe("27820000574")
  })

  it("normalises the +27 form of the same number to the same key", () => {
    // Textually different from the local form above; same key.
    expect(leadDedupKeys({ phone: "+27820000574", email: null }).phone).toBe("27820000574")
  })

  it("normalises a spaced phone to the same key as its unspaced form", () => {
    expect(leadDedupKeys({ phone: " 082 000 0574 ", email: null }).phone).toBe("27820000574")
  })

  it("lowercases and trims an email", () => {
    expect(leadDedupKeys({ phone: null, email: "  TClient3@Client.INVALID " }).email).toBe(
      "tclient3@client.invalid"
    )
  })

  it("yields NO phone key for a number outside the SA dialling plan", () => {
    // Real staging rows: too short, and too long. Different people.
    expect(leadDedupKeys({ phone: "+2780001", email: null }).phone).toBeNull()
    expect(leadDedupKeys({ phone: "+278200000910", email: null }).phone).toBeNull()
  })

  it("yields NO email key for a missing or blank email", () => {
    expect(leadDedupKeys({ phone: null, email: null }).email).toBeNull()
    expect(leadDedupKeys({ phone: null, email: "   " }).email).toBeNull()
  })

  it("yields NO email key for a placeholder that isn't shaped like an address", () => {
    // Lead.email is optional and validated on NO write path, so these reach the
    // column. They repeat across unrelated leads, which is what makes them
    // dangerous as match keys.
    for (const junk of ["N/A", "n/a", "none", "unknown", "-", "noemail", "no email@", "@x.com"]) {
      expect(leadDedupKeys({ phone: null, email: junk }).email).toBeNull()
    }
  })

  it("yields NO email key for an @ with no dotted domain", () => {
    // Pins the `\.` clause specifically. Every fixture above fails the shape
    // check for some OTHER reason (no @, a space, an empty local part), so
    // dropping the dot requirement left them all still passing.
    expect(leadDedupKeys({ phone: null, email: "n/a@n/a" }).email).toBeNull()
    expect(leadDedupKeys({ phone: null, email: "x@localhost" }).email).toBeNull()
  })

  it("still yields an email key for an unusual but address-shaped email", () => {
    // The guard must not become email validation — rejecting a real address
    // costs a missed duplicate.
    expect(leadDedupKeys({ phone: null, email: "a+b'c@sub.example.co.za" }).email).toBe(
      "a+b'c@sub.example.co.za"
    )
    expect(leadDedupKeys({ phone: null, email: "x@example.invalid" }).email).toBe(
      "x@example.invalid"
    )
  })

  it("yields NO phone key for a repeated-digit placeholder number", () => {
    // normalisePhone ACCEPTS these (its regex is /^0\d{9}$/, laxer than its own
    // docstring) and would hand back a real-looking key that many leads share.
    expect(leadDedupKeys({ phone: "0000000000", email: null }).phone).toBeNull()
    expect(leadDedupKeys({ phone: "0111111111", email: null }).phone).toBeNull()
  })

  it("still yields a phone key for a real number containing runs of zeros", () => {
    // Real staging row. The placeholder guard must not eat it.
    expect(leadDedupKeys({ phone: "+27000001230", email: null }).phone).toBe("27000001230")
  })
})

describe("duplicateReasons", () => {
  it("matches two differently-typed spellings of one phone number", () => {
    // The pair that exists on staging under two different names.
    const a = leadDedupKeys({ phone: "+27821234567", email: "e2e@example.com" })
    const b = leadDedupKeys({ phone: "0821234567", email: "lost@example.com" })
    expect(a.phone).toBe("27821234567")
    expect(b.phone).toBe("27821234567")
    expect(duplicateReasons(a, b)).toEqual(["PHONE"])
  })

  it("matches on email alone when the phones differ", () => {
    const a = leadDedupKeys({ phone: "0821111111", email: "shared@example.com" })
    const b = leadDedupKeys({ phone: "0832222222", email: "SHARED@example.com" })
    expect(duplicateReasons(a, b)).toEqual(["EMAIL"])
  })

  it("reports both channels when both match", () => {
    const a = leadDedupKeys({ phone: "0820000333", email: "tclient3@client.invalid" })
    const b = leadDedupKeys({ phone: "+27820000333", email: "tclient3@client.invalid" })
    expect(duplicateReasons(a, b)).toEqual(["PHONE", "EMAIL"])
  })

  it("does NOT match two leads whose phones are both unparseable", () => {
    // THE guard. Both keys are null; `a.phone === b.phone` is true for
    // null === null, so without the null check these two strangers become
    // duplicates of each other on the strength of a shared parse failure.
    const a = leadDedupKeys({ phone: "+2780001", email: null })
    const b = leadDedupKeys({ phone: "+2780002", email: null })
    expect(a.phone).toBeNull()
    expect(b.phone).toBeNull()
    expect(duplicateReasons(a, b)).toEqual([])
  })

  it("does NOT match two leads that both lack an email", () => {
    const a = leadDedupKeys({ phone: "0821111111", email: null })
    const b = leadDedupKeys({ phone: "0832222222", email: null })
    expect(duplicateReasons(a, b)).toEqual([])
  })

  it("does NOT match two strangers who both have a placeholder email", () => {
    // The email counterpart of the unparseable-phone guard. Without the shape
    // check these two are "the same person" because a form let both type N/A.
    const a = leadDedupKeys({ phone: "0821111111", email: "N/A" })
    const b = leadDedupKeys({ phone: "0832222222", email: "n/a" })
    expect(a.email).toBeNull()
    expect(b.email).toBeNull()
    expect(duplicateReasons(a, b)).toEqual([])
  })

  it("does NOT match two strangers who both have a placeholder phone", () => {
    const a = leadDedupKeys({ phone: "0000000000", email: "one@example.com" })
    const b = leadDedupKeys({ phone: "0000000000", email: "two@example.com" })
    expect(duplicateReasons(a, b)).toEqual([])
  })

  it("does not match unrelated leads", () => {
    const a = leadDedupKeys({ phone: "0821111111", email: "a@example.com" })
    const b = leadDedupKeys({ phone: "0832222222", email: "b@example.com" })
    expect(duplicateReasons(a, b)).toEqual([])
  })
})

describe("findDuplicateLeads", () => {
  const subject = { id: "lead-1", phone: "0820000574", email: "test.client@example.com" }

  it("finds candidates sharing the subject's phone across spellings", () => {
    const out = findDuplicateLeads(subject, [
      { id: "lead-2", phone: "+27820000574", email: "test.client@lead.invalid" },
      { id: "lead-3", phone: " 082 000 0574", email: "test.client2@lead.invalid" },
      { id: "lead-4", phone: "0119998888", email: "someone@example.com" },
    ])
    expect(out.map((d) => d.lead.id)).toEqual(["lead-2", "lead-3"])
    expect(out.map((d) => d.reasons)).toEqual([["PHONE"], ["PHONE"]])
  })

  it("never reports the subject as its own duplicate", () => {
    // Same id, and every key matches — only the id check excludes it.
    const out = findDuplicateLeads(subject, [
      { id: "lead-1", phone: "0820000574", email: "test.client@example.com" },
    ])
    expect(out).toEqual([])
  })

  it("excludes the subject by id even when a real duplicate is present", () => {
    const out = findDuplicateLeads(subject, [
      { id: "lead-1", phone: "0820000574", email: "test.client@example.com" },
      { id: "lead-9", phone: "0820000574", email: "other@example.com" },
    ])
    expect(out.map((d) => d.lead.id)).toEqual(["lead-9"])
  })

  it("returns nothing when the subject has no usable key at all", () => {
    // Unparseable phone + no email. Candidates share that same non-key.
    const out = findDuplicateLeads({ id: "s", phone: "+2780001", email: null }, [
      { id: "c1", phone: "+2780001", email: null },
      { id: "c2", phone: "+278200000910", email: null },
    ])
    expect(out).toEqual([])
  })

  it("still matches on email when the subject's phone is unparseable", () => {
    const out = findDuplicateLeads({ id: "s", phone: "+2780001", email: "x@example.com" }, [
      { id: "c1", phone: "+2780002", email: "X@Example.com" },
    ])
    expect(out.map((d) => d.lead.id)).toEqual(["c1"])
    expect(out[0].reasons).toEqual(["EMAIL"])
  })

  it("returns an empty list when there are no candidates", () => {
    expect(findDuplicateLeads(subject, [])).toEqual([])
  })
})

describe("applyCandidateCap", () => {
  // A small literal limit, NOT DEDUP_SCAN_LIMIT. Sizing these fixtures off the
  // real constant would make them pass at any value of it — including a value
  // that broke the boundary.
  const LIMIT = 3

  it("does not truncate an under-full page", () => {
    // Caller fetched LIMIT+1 and got fewer back: there is no more.
    const out = applyCandidateCap(["a", "b"], LIMIT)
    expect(out.truncated).toBe(false)
    expect(out.candidates).toEqual(["a", "b"])
  })

  it("does not truncate a page that exactly fills the cap", () => {
    // THE boundary. `>=` here would report truncation forever on an exact fit.
    const out = applyCandidateCap(["a", "b", "c"], LIMIT)
    expect(out.truncated).toBe(false)
    expect(out.candidates).toEqual(["a", "b", "c"])
  })

  it("truncates and reports when the probe row comes back", () => {
    // LIMIT+1 rows: the extra row is the signal, and must not be kept.
    const out = applyCandidateCap(["a", "b", "c", "d"], LIMIT)
    expect(out.truncated).toBe(true)
    expect(out.candidates).toEqual(["a", "b", "c"])
  })

  it("keeps the first `limit` rows, dropping the overflow", () => {
    const out = applyCandidateCap(["a", "b", "c", "d", "e"], LIMIT)
    expect(out.truncated).toBe(true)
    expect(out.candidates).toEqual(["a", "b", "c"])
  })

  it("handles an empty page", () => {
    const out = applyCandidateCap([], LIMIT)
    expect(out.truncated).toBe(false)
    expect(out.candidates).toEqual([])
  })
})

describe("countDuplicatesByPhone", () => {
  const lead = (id: string, phone: string | null, email: string | null = null) => ({ id, phone, email })

  it("reports NOTHING for a board where every phone is a placeholder", () => {
    // THE failure this rule exists to prevent. Fifty leads carrying the same
    // junk number must not each wear a "49 duplicates" badge — a badge that is
    // usually wrong is one staff learn to ignore, which costs the real ones.
    const leads = Array.from({ length: 50 }, (_, i) => lead(`junk-${i}`, "0000000000"))
    const counts = countDuplicatesByPhone(leads)
    expect(counts.size).toBe(0)
  })

  it("matches two spellings of one number", () => {
    // Staging holds exactly this pair under two different names.
    const counts = countDuplicatesByPhone([
      lead("a", "+27821234567"),
      lead("b", "0821234567"),
    ])
    expect(counts.get("a")).toBe(1)
    expect(counts.get("b")).toBe(1)
  })

  it("counts the OTHERS, never the lead itself", () => {
    // A lone lead is absent from the map, not present with 0 — the card reads
    // `> 0`, and a self-match would badge every lead on the board.
    const counts = countDuplicatesByPhone([lead("only", "0820000574")])
    expect(counts.has("only")).toBe(false)
  })

  it("counts every other member of a group of three", () => {
    const counts = countDuplicatesByPhone([
      lead("a", "0820000574"),
      lead("b", "082 000 0574"),
      lead("c", "+27820000574"),
    ])
    expect([counts.get("a"), counts.get("b"), counts.get("c")]).toEqual([2, 2, 2])
  })

  it("keeps separate numbers in separate groups", () => {
    const counts = countDuplicatesByPhone([
      lead("a", "0820000574"),
      lead("b", "0820000574"),
      lead("c", "0837654321"),
    ])
    expect(counts.get("a")).toBe(1)
    expect(counts.get("b")).toBe(1)
    expect(counts.has("c")).toBe(false)
  })

  it("ignores a shared EMAIL — the board badges on phone only", () => {
    // Deliberate divergence from findDuplicateLeads. An address-shaped
    // placeholder ("test@test.com") is a valid match key that the review page
    // tolerates because a human is looking at the evidence; a permanent badge
    // has no such reader. See the note on the function.
    // Both phones are unparseable, so PHONE cannot be what decides this — if
    // the rule consulted email at all, in any order or as a fallback, these two
    // would match. A fixture with two VALID distinct phones would pass either
    // way and pin nothing.
    const counts = countDuplicatesByPhone([
      lead("a", "+2780001", "test@test.com"),
      lead("b", "+278200000910", "test@test.com"),
    ])
    expect(counts.size).toBe(0)
  })

  it("ignores a shared email even when it is a REAL address", () => {
    // Not a placeholder question: a real shared address (a couple, a work
    // account) is still not the board's signal. Same reason — no evidence
    // travels with a badge.
    const counts = countDuplicatesByPhone([
      lead("a", null, "tclient3@client.invalid"),
      lead("b", null, "tclient3@client.invalid"),
    ])
    expect(counts.size).toBe(0)
  })

  it("ignores an unparseable phone rather than matching on the raw string", () => {
    const counts = countDuplicatesByPhone([
      lead("a", "+2780001"),
      lead("b", "+2780001"),
    ])
    expect(counts.size).toBe(0)
  })

  it("handles an empty board", () => {
    expect(countDuplicatesByPhone([]).size).toBe(0)
  })
})

describe("describeReasons", () => {
  it("renders one reason", () => {
    expect(describeReasons(["PHONE"])).toBe("same phone number")
    expect(describeReasons(["EMAIL"])).toBe("same email address")
  })

  it("renders both reasons", () => {
    expect(describeReasons(["PHONE", "EMAIL"])).toBe("same phone number and same email address")
  })

  it("renders nothing for no reasons", () => {
    expect(describeReasons([])).toBe("")
  })
})

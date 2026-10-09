import { describe, it, expect } from "vitest"
import {
  normaliseFullName,
  leadIdentityKey,
  isPriorLeadCandidate,
  findPriorOpenLeads,
  type LeadIdentityFields,
} from "@/lib/crm/lead-identity"

// Expected keys are written as LITERALS. Deriving them from normalisePhone /
// normaliseFullName — the functions under test — would make every assertion
// true by construction.
//
// The cluster fixtures below are the real shape of prod as of 2026-08-15
// (names and contact details replaced with synthetic ones): six phone clusters covering 23 of 43
// leads, five of which are one person and one of which is three people.

const lead = (over: Partial<LeadIdentityFields> & { id: string }): LeadIdentityFields => ({
  firstName: "Test",
  lastName: "Person",
  phone: "0820000574",
  status: "NEW",
  convertedToClientId: null,
  convertedToApplicationId: null,
  conversionRecoveryRequired: false,
  ...over,
})

describe("normaliseFullName", () => {
  it("lowercases and trims", () => {
    expect(normaliseFullName("Nhlanhla", "Mocktest")).toBe("nhlanhla mocktest")
  })

  it("collapses the internal double space seen in real rows", () => {
    // Prod stores this lead as "nhlanhla  mocktest " — double space AND a
    // trailing space. Without the collapse it is a different person.
    expect(normaliseFullName("Nhlanhla ", " Mocktest ")).toBe("nhlanhla mocktest")
    expect(normaliseFullName("Lerato", " Testerson")).toBe("lerato testerson")
  })

  it("returns empty string when there is no usable name", () => {
    expect(normaliseFullName(null, null)).toBe("")
    expect(normaliseFullName("  ", " ")).toBe("")
  })

  it("keeps a single-word name rather than discarding it", () => {
    expect(normaliseFullName("Madonna", null)).toBe("madonna")
  })
})

describe("leadIdentityKey", () => {
  it("combines phone and name", () => {
    expect(leadIdentityKey(lead({ id: "a", firstName: "Johan", lastName: "van Testhuis" })))
      .toBe("27820000574|johan van testhuis")
  })

  it("gives the SAME key to +27 and 0 spellings of one number", () => {
    const a = leadIdentityKey(lead({ id: "a", phone: "+27820000574", firstName: "Johan", lastName: "van Testhuis" }))
    const b = leadIdentityKey(lead({ id: "b", phone: "082 000 0574", firstName: "Johan", lastName: "van Testhuis" }))
    expect(a).toBe(b)
    expect(a).not.toBeNull()
  })

  it("gives DIFFERENT keys to two people on one phone", () => {
    // THE case that forbids a phone-only key. Both rows are real on prod.
    const johan = leadIdentityKey(lead({ id: "a", firstName: "Johan", lastName: "van Testhuis" }))
    const marie = leadIdentityKey(lead({ id: "b", firstName: "Marie", lastName: "van Testhuis" }))
    expect(johan).not.toBe(marie)
  })

  it("is null when the phone is a placeholder", () => {
    expect(leadIdentityKey(lead({ id: "a", phone: "0000000000" }))).toBeNull()
  })

  it("is null when the phone is unparseable", () => {
    expect(leadIdentityKey(lead({ id: "a", phone: "+2784569" }))).toBeNull()
  })

  it("is null when there is no name, even with a good phone", () => {
    // A phone with no name is a phone, not an identity — falling back to the
    // phone alone here would silently reintroduce the shared-handset bug.
    expect(leadIdentityKey(lead({ id: "a", firstName: "", lastName: "" }))).toBeNull()
  })

  it("ignores email entirely", () => {
    // One prod lead has three addresses, one a mistyped domain. If
    // email were in the key she would be three people.
    const one = leadIdentityKey(lead({ id: "a", firstName: "Dineo", lastName: "Testperson", phone: "0820000082" }))
    const two = leadIdentityKey(lead({ id: "b", firstName: "Dineo", lastName: "Testperson", phone: "0820000082" }))
    expect(one).toBe(two)
  })
})

describe("isPriorLeadCandidate", () => {
  it("accepts an ordinary open lead", () => {
    for (const status of ["NEW", "CONTACTED", "QUALIFIED", "PROPOSAL_SENT"]) {
      expect(isPriorLeadCandidate(lead({ id: "a", status }))).toBe(true)
    }
  })

  it("REJECTS a LOST lead", () => {
    // leadConversionState() calls a LOST lead with no links "OPEN" — that word
    // means "convertible", not "active". Using it alone as the filter would
    // notify agents about leads they deliberately wrote off.
    expect(isPriorLeadCandidate(lead({ id: "a", status: "LOST" }))).toBe(false)
  })

  it("REJECTS a completed conversion", () => {
    expect(isPriorLeadCandidate(lead({
      id: "a", status: "CONVERTED",
      convertedToClientId: "cli_1", convertedToApplicationId: "app_1",
    }))).toBe(false)
  })

  it("REJECTS stranded and incomplete recovery rows", () => {
    expect(isPriorLeadCandidate(lead({ id: "a", status: "CONVERTED" }))).toBe(false)
    expect(isPriorLeadCandidate(lead({
      id: "b", status: "QUALIFIED", conversionRecoveryRequired: true,
    }))).toBe(false)
    expect(isPriorLeadCandidate(lead({
      id: "c", status: "QUALIFIED", convertedToClientId: "cli_1",
    }))).toBe(false)
  })
})

describe("findPriorOpenLeads", () => {
  const subject = lead({ id: "new", firstName: "Nhlanhla", lastName: "Mocktest", phone: "0820000048" })

  it("finds the earlier open lead for the same person", () => {
    const prior = lead({ id: "old", firstName: "Nhlanhla ", lastName: " Mocktest", phone: "+27820000048", status: "CONTACTED" })
    expect(findPriorOpenLeads(subject, [prior]).map((l) => l.id)).toEqual(["old"])
  })

  it("never returns the subject itself", () => {
    expect(findPriorOpenLeads(subject, [subject])).toEqual([])
  })

  it("does NOT match a different person on the same phone", () => {
    const marie = lead({ id: "marie", firstName: "Marie", lastName: "van Testhuis", phone: "0820000574" })
    const johan = lead({ id: "johan", firstName: "Johan", lastName: "van Testhuis", phone: "0820000574" })
    expect(findPriorOpenLeads(johan, [marie])).toEqual([])
  })

  it("does not match a LOST prior lead", () => {
    const prior = lead({ id: "old", firstName: "Nhlanhla", lastName: "Mocktest", phone: "0820000048", status: "LOST" })
    expect(findPriorOpenLeads(subject, [prior])).toEqual([])
  })

  it("returns nothing when the subject has no usable identity", () => {
    const junk = lead({ id: "junk", firstName: "Nhlanhla", lastName: "Mocktest", phone: "0000000000" })
    const prior = lead({ id: "old", firstName: "Nhlanhla", lastName: "Mocktest", phone: "0000000000", status: "NEW" })
    expect(findPriorOpenLeads(junk, [prior])).toEqual([])
  })

  it("returns every open duplicate when there are several", () => {
    const a = lead({ id: "a", firstName: "Kagiso", lastName: "Synthetic", phone: "0820000200", status: "PROPOSAL_SENT" })
    const b = lead({ id: "b", firstName: "Kagiso", lastName: "Synthetic", phone: "0820000200", status: "NEW" })
    const lost = lead({ id: "lost", firstName: "Kagiso", lastName: "Synthetic", phone: "0820000200", status: "LOST" })
    const subj = lead({ id: "new", firstName: "Kagiso", lastName: "Synthetic", phone: "0820000200" })
    expect(findPriorOpenLeads(subj, [a, b, lost]).map((l) => l.id).sort()).toEqual(["a", "b"])
  })
})

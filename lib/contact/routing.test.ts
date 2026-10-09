import { describe, it, expect } from "vitest"
import { contactNeedsTriage, resolveContactHref } from "./routing"

describe("contactNeedsTriage", () => {
  it("is false when there is no ambiguous-match payload", () => {
    expect(contactNeedsTriage(null)).toBe(false)
    expect(contactNeedsTriage(undefined)).toBe(false)
  })

  it("is false for a well-formed but empty payload", () => {
    expect(contactNeedsTriage({ clients: [], leads: [] })).toBe(false)
    expect(contactNeedsTriage({})).toBe(false)
  })

  it("is true when at least one candidate client or lead is present", () => {
    expect(contactNeedsTriage({ clients: ["cl_1"], leads: [] })).toBe(true)
    expect(contactNeedsTriage({ clients: [], leads: ["ld_1"] })).toBe(true)
  })

  it("is false for a malformed payload (non-string ids)", () => {
    expect(contactNeedsTriage({ clients: [1, 2] })).toBe(false)
    expect(contactNeedsTriage("not-an-object")).toBe(false)
  })
})

describe("resolveContactHref", () => {
  const base = { id: "ct_1", clientId: null, leadId: null, ambiguousMatchCandidates: null, lead: null }
  const completeLead = {
    status: "CONVERTED",
    convertedToClientId: "cl_from_lead",
    convertedToApplicationId: "app_from_lead",
    conversionRecoveryRequired: false,
  }

  it("keeps the triage page when the contact is ambiguous, even if it links to a record", () => {
    expect(
      resolveContactHref({
        ...base,
        clientId: "cl_9",
        leadId: "ld_9",
        ambiguousMatchCandidates: { clients: ["cl_other"], leads: [] },
      }),
    ).toBe("/contacts/ct_1")
  })

  it("routes a client contact straight to the client record", () => {
    expect(resolveContactHref({ ...base, clientId: "cl_9" })).toBe("/clients/cl_9")
  })

  it("prefers the client a converted lead became", () => {
    expect(
      resolveContactHref({ ...base, leadId: "ld_9", lead: completeLead }),
    ).toBe("/clients/cl_from_lead")
  })

  it("routes an un-converted lead contact straight to the lead record", () => {
    expect(
      resolveContactHref({
        ...base,
        leadId: "ld_9",
        lead: {
          status: "QUALIFIED",
          convertedToClientId: null,
          convertedToApplicationId: null,
          conversionRecoveryRequired: false,
        },
      }),
    ).toBe("/crm/leads/ld_9")
  })

  it.each([
    ["client-only", "cl_partial", null, true],
    ["stranded", null, null, true],
    ["status/link mismatch", "cl_partial", null, false],
  ])("keeps a %s recovery row on the lead even when the Contact also links a client", (
    _label,
    convertedToClientId,
    convertedToApplicationId,
    conversionRecoveryRequired,
  ) => {
    expect(resolveContactHref({
      ...base,
      clientId: "cl_contact",
      leadId: "ld_9",
      lead: {
        status: "CONVERTED",
        convertedToClientId,
        convertedToApplicationId,
        conversionRecoveryRequired,
      },
    })).toBe("/crm/leads/ld_9")
  })

  it("prefers client over lead when a contact links to both", () => {
    expect(resolveContactHref({ ...base, clientId: "cl_9", leadId: "ld_9" })).toBe("/clients/cl_9")
  })

  it("falls back to the identity page when there is nothing to route to", () => {
    expect(resolveContactHref(base)).toBe("/contacts/ct_1")
  })
})

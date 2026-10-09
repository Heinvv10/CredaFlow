import { describe, it, expect } from "vitest"
import { duplicateNotice } from "./duplicate-notice"

/**
 * What the operator is told, given whatever the lookup came back with.
 *
 * Kept as a pure function because the interesting decisions — say nothing while
 * we do not know, never name a client from another tenant, never claim a
 * duplicate on a failed request — have nothing to do with React and should not
 * need a rendered component to assert.
 */

describe("duplicateNotice", () => {
  it("says nothing before a lookup has happened", () => {
    expect(duplicateNotice(null)).toEqual({ show: false })
  })

  it("says nothing when the ID is free", () => {
    expect(duplicateNotice({ exists: false, sameTenant: false, client: null })).toEqual({
      show: false,
    })
  })

  it("names the existing client when they belong to this tenant", () => {
    expect(
      duplicateNotice({
        exists: true,
        sameTenant: true,
        client: { id: "c1", reference: "CLI-00042", firstName: "Themba", lastName: "Cele" },
      })
    ).toEqual({
      show: true,
      message: "This ID number already belongs to Themba Cele (CLI-00042)",
      clientId: "c1",
    })
  })

  it("reports the clash without naming anyone when the client is another tenant's", () => {
    // The unique index is global. Saying "already registered" is the whole
    // truth we are entitled to tell — a name here would be a cross-tenant leak.
    expect(duplicateNotice({ exists: true, sameTenant: false, client: null })).toEqual({
      show: true,
      message: "This ID number is already registered and cannot be used again",
    })
  })

  it("does not name a client when the payload claims same-tenant but carries nobody", () => {
    // Defensive: a malformed response must not render "belongs to undefined".
    expect(duplicateNotice({ exists: true, sameTenant: true, client: null })).toEqual({
      show: true,
      message: "This ID number is already registered and cannot be used again",
    })
  })
})

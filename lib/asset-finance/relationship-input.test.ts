import { describe, expect, it } from "vitest"
import { parseRelationshipInput, relationshipRowValues } from "./relationship-input"

const errorsOf = (body: unknown, type: "COMPANY" | "CC" | "TRUST" | "PARTNERSHIP" = "COMPANY") => {
  const result = parseRelationshipInput(body, type)
  return "errors" in result ? result.errors : {}
}

describe("parseRelationshipInput", () => {
  it("accepts several roles for one person, deduplicated", () => {
    expect(parseRelationshipInput({ clientId: " c1 ", roles: ["DIRECTOR", "SURETY", "DIRECTOR"] }, "COMPANY")).toEqual({
      data: { clientId: "c1", roles: ["DIRECTOR", "SURETY"], trusteeKind: null, ownershipPct: null },
    })
  })

  it("requires a trustee kind for a trustee, and refuses one for anyone else", () => {
    expect(errorsOf({ clientId: "c1", roles: ["TRUSTEE"] }, "TRUST")).toHaveProperty("trusteeKind")
    expect(errorsOf({ clientId: "c1", roles: ["TRUSTEE"], trusteeKind: "SOMETIMES" }, "TRUST")).toHaveProperty("trusteeKind")
    expect(errorsOf({ clientId: "c1", roles: ["SURETY"], trusteeKind: "NATURAL" }, "TRUST")).toHaveProperty("trusteeKind")
    expect(errorsOf({ clientId: "c1", roles: ["TRUSTEE", "SURETY"], trusteeKind: "JURISTIC" }, "TRUST")).toEqual({})
  })

  it.each([
    ["TRUSTEE", "COMPANY"],
    ["DIRECTOR", "TRUST"],
    ["DIRECTOR", "CC"],
    ["MEMBER", "COMPANY"],
  ] as const)("refuses %s on a %s", (role, type) => {
    expect(errorsOf({ clientId: "c1", roles: [role], trusteeKind: "NATURAL" }, type)).toHaveProperty("roles")
  })

  it("refuses no roles, an unknown role and a missing client", () => {
    expect(errorsOf({ clientId: "c1", roles: [] })).toHaveProperty("roles")
    expect(errorsOf({ clientId: "c1", roles: ["CEO"] })).toHaveProperty("roles")
    expect(errorsOf({ roles: ["DIRECTOR"] })).toHaveProperty("clientId")
  })

  it("takes an ownership share only for a member or beneficial owner, 0–100 with two decimals", () => {
    expect(errorsOf({ clientId: "c1", roles: ["DIRECTOR"], ownershipPct: 50 })).toHaveProperty("ownershipPct")
    expect(errorsOf({ clientId: "c1", roles: ["BENEFICIAL_OWNER"], ownershipPct: "100.01" })).toHaveProperty("ownershipPct")
    expect(errorsOf({ clientId: "c1", roles: ["BENEFICIAL_OWNER"], ownershipPct: "12.345" })).toHaveProperty("ownershipPct")
    expect(parseRelationshipInput({ clientId: "c1", roles: ["DIRECTOR", "BENEFICIAL_OWNER"], ownershipPct: 25.5 }, "COMPANY"))
      .toMatchObject({ data: { ownershipPct: "25.5" } })
  })
})

describe("relationshipRowValues", () => {
  it("puts the trustee kind only on the TRUSTEE row (CHECK EntityRelationship_trustee_kind) and the share only on owner rows", () => {
    const input = { clientId: "c1", roles: ["TRUSTEE", "BENEFICIAL_OWNER", "SURETY"] as const, trusteeKind: "NATURAL" as const, ownershipPct: "40" }
    const data = { ...input, roles: [...input.roles] }
    expect(relationshipRowValues(data, "TRUSTEE")).toEqual({ trusteeKind: "NATURAL", ownershipPct: null })
    expect(relationshipRowValues(data, "BENEFICIAL_OWNER")).toEqual({ trusteeKind: null, ownershipPct: "40" })
    expect(relationshipRowValues(data, "SURETY")).toEqual({ trusteeKind: null, ownershipPct: null })
  })
})

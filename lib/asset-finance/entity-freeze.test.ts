import { describe, expect, it } from "vitest"
import type { BusinessEntityInput } from "./entity-input"
import { SIGNED_ENTITY_FIELDS, signedEntityChanges } from "./entity-freeze"

const ENTITY: BusinessEntityInput = {
  type: "COMPANY",
  legalName: "TEST Plant Hire (Pty) Ltd",
  tradingName: null,
  registrationNumber: "2015/123456/07",
  mastersReference: null,
  vatNumber: null,
  annualTurnover: 100_000_000,
  totalAssetValue: null,
  financialYearEnd: new Date("2026-02-28T00:00:00.000Z"),
  addressLine1: "1 Test Road",
  addressLine2: null,
  city: "Testville",
  province: "Gauteng",
  postalCode: "0001",
}

describe("signedEntityChanges", () => {
  it("reports every identity field rendered in an agreement", () => {
    const changed = Object.fromEntries(SIGNED_ENTITY_FIELDS.map((field) => [field, field === "type" ? "CC" : "changed"])) as unknown as BusinessEntityInput
    expect(signedEntityChanges(ENTITY, { ...ENTITY, ...changed })).toEqual(SIGNED_ENTITY_FIELDS)
  })

  it("does not freeze classifier financial figures", () => {
    const changed = { ...ENTITY, annualTurnover: 200_000_000 }
    expect(signedEntityChanges(ENTITY, changed)).toEqual([])
  })
})

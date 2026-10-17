import { describe, expect, it } from "vitest"
import { AGREEMENT_DECLARATION_PAYLOAD, validAgreementDeclarations } from "./agreement-declaration-set"
describe("versioned portal declaration acceptance", () => {
  it("requires all five exact declarations and the current version", () => {
    expect(validAgreementDeclarations(AGREEMENT_DECLARATION_PAYLOAD)).toBe(true)
    for (const bad of [null, {}, { ...AGREEMENT_DECLARATION_PAYLOAD, version: "old" }, { ...AGREEMENT_DECLARATION_PAYLOAD, acceptedIds: AGREEMENT_DECLARATION_PAYLOAD.acceptedIds.slice(1) }, { ...AGREEMENT_DECLARATION_PAYLOAD, acceptedIds: Array(5).fill("pasq_read") }]) expect(validAgreementDeclarations(bad)).toBe(false)
  })
})

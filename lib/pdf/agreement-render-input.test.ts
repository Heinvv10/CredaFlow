import { describe, it, expect } from "vitest"
import { buildAgreementRenderInput } from "./agreement-render-input"

// This mapping is the ONE place agreement render options are assembled, shared
// by generation and countersignature so the executed artifact can reproduce the
// signed document byte-for-byte. A field dropped here is dropped from an NCA
// document in both routes at once, so each disclosure field is pinned.
const evidence = {
  providerIdentity: { tenantName: "Acme Lending", statutoryNcrNumber: "NCRCP12345" },
  client: {
    firstName: "Thandeka",
    lastName: "Mokoena",
    idNumber: "8501015000080",
    addressLine1: "45 Oak Avenue",
    suburb: "Orlando",
    city: "Soweto",
    province: "Gauteng",
    postalCode: "1804",
    phone: "+27821234567",
  },
  application: { reference: "APP-001", agreementType: "Short-term Credit" },
  approvalInputs: {
    termDays: 30,
    interestRatePm: 0.05,
    interestModel: "FLAT",
    monthlyServiceFeeCents: 6900,
    initiationFeePayment: "DEFERRED" as const,
  },
  calc: { principal: 500000 } as never,
  startDate: new Date("2026-05-15"),
  maturityDate: new Date("2026-06-14"),
  quotePresentedAt: new Date("2026-05-15T08:00:00.000Z"),
  quoteValidUntilDate: "2026-05-22",
  creditLifeAutoBundleEligible: false,
  creditLifeNotOffered: true,
}

describe("buildAgreementRenderInput", () => {
  // Regulation 29 requires the consumer's contact number on the document. A
  // source-grep guard used to protect this at each call site; centralising the
  // mapping means it is protected HERE, behaviourally, for every caller.
  it("carries the consumer's phone through to the renderer", () => {
    expect(buildAgreementRenderInput(evidence).client.phone).toBe("+27821234567")
  })

  it("carries every Regulation 29 address component", () => {
    const client = buildAgreementRenderInput(evidence).client
    expect(client).toMatchObject({
      addressLine1: "45 Oak Avenue",
      suburb: "Orlando",
      city: "Soweto",
      province: "Gauteng",
      postalCode: "1804",
    })
  })

  // null and undefined are NOT interchangeable downstream: creditAgreement.ts
  // renders a dash for undefined but would print "null" for a null.
  it("normalises absent optional client fields to undefined, never null", () => {
    const input = buildAgreementRenderInput({
      ...evidence,
      client: { ...evidence.client, phone: null, suburb: null, province: null, postalCode: null },
    })
    expect(input.client.phone).toBeUndefined()
    expect(input.client.suburb).toBeUndefined()
    expect(input.client.province).toBeUndefined()
    expect(input.client.postalCode).toBeUndefined()
  })

  it("prices from the FROZEN approval inputs, not live product data", () => {
    const input = buildAgreementRenderInput(evidence)
    expect(input.product).toEqual({
      interestRatePm: 0.05,
      interestModel: "FLAT",
      monthlyServiceFee: 6900,
    })
    expect(input.application.appliedTermDays).toBe(30)
    expect(input.initiationFeePayment).toBe("DEFERRED")
  })

  // creditAgreement.ts prints "Offered Credit Life Product/Insurer/Premium"
  // whenever this key is PRESENT — including on a decline. Passing an empty
  // object would state on an NCA document that cover was offered and refused
  // when none was ever available.
  it("omits creditLife entirely when no cover was offered", () => {
    expect(buildAgreementRenderInput(evidence).creditLife).toBeUndefined()
  })

  // Fair Score audit B6: "Not offered" prints only from the stored record.
  it("carries the stored no-offer record through as an explicit flag", () => {
    expect(buildAgreementRenderInput(evidence).creditLifeNotOffered).toBe(true)
    expect(buildAgreementRenderInput({ ...evidence, creditLifeNotOffered: false }).creditLifeNotOffered).toBe(false)
  })

  it("passes credit-life cover through untouched when it was offered", () => {
    const input = buildAgreementRenderInput({
      ...evidence,
      creditLifeNotOffered: false,
      creditLifeAutoBundleEligible: true,
      creditLife: {
        elected: true,
        productName: "Acme Credit Life",
        insurerName: "Test Life",
        monthlyPremiumCents: 2250,
        premiumPeriods: 1,
        totalPremiumCents: 2250,
      },
    })
    expect(input.willAutoBundleCl).toBe(true)
    expect(input.creditLife).toMatchObject({
      productName: "Acme Credit Life",
      insurerName: "Test Life",
      monthlyPremiumCents: 2250,
    })
  })

  it("is deterministic — the same evidence always yields the same input", () => {
    // The whole countersignature safety argument rests on this: re-running the
    // mapping over unchanged evidence must reproduce the signed document.
    expect(buildAgreementRenderInput(evidence)).toEqual(buildAgreementRenderInput(evidence))
  })
})

import { $Enums } from "@prisma/client"
import { describe, expect, it } from "vitest"
import {
  CHECKLIST_EVIDENCE_TYPES,
  CHECKLIST_KINDS,
  SIGNING_ITEMS,
  assetBlocker,
  needsDualApproval,
  normaliseName,
  payoutAmountCents,
  requiredChecklistKinds,
  serialAttestationMatches,
  type ChecklistAsset,
} from "./payout-checklist"

const asset: ChecklistAsset = {
  serialNumber: "TESTSERIAL0001",
  vin: "TEST0000000000001",
  registrationNumber: null,
  natisTitleholder: null,
  trackerId: "TRK-TEST-1",
  lenderNotedConfirmed: true,
}

describe("requirement table", () => {
  it("covers every PayoutChecklistItemKind (the SQL twin uses the whole enum)", () => {
    expect([...CHECKLIST_KINDS].sort()).toEqual(Object.values($Enums.PayoutChecklistItemKind).sort())
  })

  it("an unregistered asset needs every item but the eNaTIS titleholder", () => {
    const kinds = requiredChecklistKinds("INSTALMENT_SALE", { registrationNumber: null })
    expect(kinds).toHaveLength(8)
    expect(kinds).not.toContain("NATIS_TITLEHOLDER")
    expect(requiredChecklistKinds("INSTALMENT_SALE", { registrationNumber: "   " })).not.toContain("NATIS_TITLEHOLDER")
  })

  it("a registered asset needs the eNaTIS titleholder too", () => {
    const kinds = requiredChecklistKinds("INSTALMENT_SALE", { registrationNumber: "TEST123GP" })
    expect(kinds).toEqual([...CHECKLIST_KINDS])
  })

  it("uses the instalment-sale checklist for a finance lease", () => {
    expect(requiredChecklistKinds("FINANCE_LEASE", { registrationNumber: null }))
      .toEqual(requiredChecklistKinds("INSTALMENT_SALE", { registrationNumber: null }))
  })

  it("names evidence for every item except the three signing items", () => {
    for (const kind of CHECKLIST_KINDS) {
      expect(CHECKLIST_EVIDENCE_TYPES[kind].length === 0).toBe(SIGNING_ITEMS.includes(kind))
    }
  })
})

describe("serial attestation", () => {
  it("accepts the asset's serial or VIN, ignoring case and outer spaces", () => {
    expect(serialAttestationMatches(" testserial0001 ", asset)).toBe(true)
    expect(serialAttestationMatches("TEST0000000000001", asset)).toBe(true)
  })

  it("compares as the duplicate checks do: separators and Unicode spaces ignored, fullwidth folded", () => {
    expect(serialAttestationMatches("test-serial 0001", asset)).toBe(true)
    expect(serialAttestationMatches("TEST.SERIAL\u00A00001", asset)).toBe(true)
    expect(serialAttestationMatches("TEST 0000 0000 0000 1", asset)).toBe(true)
    expect(serialAttestationMatches("\uFF34\uFF25\uFF33\uFF34SERIAL0001", asset)).toBe(true)
  })

  it("never matches a value the identifier policy refuses (zero-width, en dash, look-alike letters)", () => {
    expect(serialAttestationMatches("TEST.SERIAL\u200B0001", asset)).toBe(false)
    expect(serialAttestationMatches("TEST\u2013SERIAL0001", asset)).toBe(false)
    expect(serialAttestationMatches("\u0422ESTSERIAL0001", asset)).toBe(false)
  })

  it("refuses a mismatch, a near-miss and a blank", () => {
    expect(serialAttestationMatches("TESTSERIAL0002", asset)).toBe(false)
    expect(serialAttestationMatches("TESTSERIAL000", asset)).toBe(false)
    expect(serialAttestationMatches("", asset)).toBe(false)
    expect(serialAttestationMatches("   ", { ...asset, vin: null })).toBe(false)
  })
})

describe("asset readiness", () => {
  it("insurance and tracker items need the asset recorded first", () => {
    expect(assetBlocker("INSURANCE_NOTES_LENDER", { ...asset, lenderNotedConfirmed: false }, null)).toMatch(/insurer/)
    expect(assetBlocker("INSURANCE_NOTES_LENDER", asset, null)).toBeNull()
    expect(assetBlocker("TRACKER_CONFIRMED", { ...asset, trackerId: " " }, null)).toMatch(/tracker/)
    expect(assetBlocker("TRACKER_CONFIRMED", asset, null)).toBeNull()
  })

  it("the eNaTIS titleholder must be the lender's legal name (normalised)", () => {
    const registered = { ...asset, registrationNumber: "TEST123GP", natisTitleholder: "test  lender (pty)   ltd " }
    expect(assetBlocker("NATIS_TITLEHOLDER", registered, "TEST Lender (Pty) Ltd")).toBeNull()
    expect(assetBlocker("NATIS_TITLEHOLDER", { ...registered, natisTitleholder: "TEST Earthmoving (Pty) Ltd" }, "TEST Lender (Pty) Ltd")).toMatch(/lender/)
    expect(assetBlocker("NATIS_TITLEHOLDER", { ...registered, natisTitleholder: null }, "TEST Lender (Pty) Ltd")).not.toBeNull()
    expect(assetBlocker("NATIS_TITLEHOLDER", registered, null)).toMatch(/legal name/)
    expect(assetBlocker("NATIS_TITLEHOLDER", asset, "TEST Lender (Pty) Ltd")).toMatch(/no registration/)
    expect(normaliseName(" a \t b ")).toBe("A B")
  })
})

describe("payout amount", () => {
  it("is the cash price incl. VAT less deposit and trade-in; financed fees are not paid out", () => {
    // R1 500 000 + R225 000 VAT − R172 500 deposit − R50 000 trade-in = R1 502 500.
    expect(payoutAmountCents({ cashPriceExclVatCents: 150_000_000, vatCents: 22_500_000, depositCents: 17_250_000, tradeInCents: 5_000_000 }))
      .toBe(150_250_000)
  })

  it("needs a second approver at or above the threshold, not below", () => {
    expect(needsDualApproval(100_000_000, 100_000_000)).toBe(true)
    expect(needsDualApproval(99_999_999, 100_000_000)).toBe(false)
  })
})

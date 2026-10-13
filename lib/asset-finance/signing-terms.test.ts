import { Prisma } from "@prisma/client"
import { describe, expect, it, vi } from "vitest"
import { pdfPageContents } from "@/lib/pdf/__tests__/pdf-test-utils"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { plannedStartProblem } from "./signing-prepare"
import { preparedTermProblem, snapshotArrearsMargin } from "./documents/deal-document-data"
import { deriveRequiredSigners, preparedSignerSet, requiredFromPrepared } from "./signing"
import { renderInstalmentSaleAgreement } from "./documents/agreement-pdf"
import { syntheticDealDocumentData } from "./documents/synthetic-deal.fixture"

// The contract terms fixed at preparation (review item 1): the planned start
// date, the prepared signer set as stored, and the arrears terms printed in
// section 5 of the agreement.
describe("plannedStartProblem", () => {
  const TODAY = "2026-10-13"
  it("accepts a start before the first instalment, refuses one on or after it and a malformed date", () => {
    expect(plannedStartProblem("2026-10-13", "2026-11-13", TODAY)).toBeNull()
    expect(plannedStartProblem("2026-11-12", "2026-11-13", TODAY)).toBeNull()
    expect(plannedStartProblem("2026-11-13", "2026-11-13", TODAY)).toMatch(/before the first instalment \(2026-11-13\)/)
    expect(plannedStartProblem("2026-12-01", "2026-11-13", TODAY)).toMatch(/before the first instalment/)
    expect(plannedStartProblem("2026-02-30", "2026-11-13", TODAY)).toMatch(/calendar date/)
  })

  it("refuses a backdated start and one more than 90 days ahead (today SAST is the floor)", () => {
    expect(plannedStartProblem("2026-10-12", "2026-11-13", TODAY)).toMatch(/may not be in the past \(today is 2026-10-13\)/)
    expect(plannedStartProblem("2020-02-01", "2026-11-13", TODAY)).toMatch(/may not be in the past/)
    expect(plannedStartProblem("2027-01-11", "2027-06-01", TODAY)).toBeNull()
    expect(plannedStartProblem("2027-01-12", "2027-06-01", TODAY)).toMatch(/at most 90 days ahead \(2027-01-11\)/)
  })
})

describe("preparedTermProblem", () => {
  it("refuses a term beyond the product or the credit decision", () => {
    expect(preparedTermProblem(366, 365, 30, 730)).toMatch(/exceeds the approved term/)
    expect(preparedTermProblem(731, 900, 30, 730)).toMatch(/outside the product/)
    expect(preparedTermProblem(29, 365, 30, 730)).toMatch(/outside the product/)
    expect(preparedTermProblem(365, 365, 30, 730)).toBeNull()
    expect(preparedTermProblem(300, 365, 30, 730)).toBeNull()
  })
})

it("preserves disabled default interest distinctly from a zero margin", () => {
  expect(snapshotArrearsMargin(null)).toBeNull()
  expect(snapshotArrearsMargin(new Prisma.Decimal(0))).toBe("0")
})

describe("the prepared signer set", () => {
  const required = deriveRequiredSigners("COMPANY", [
    { clientId: "c-director", role: "DIRECTOR", active: true },
    { clientId: "c-surety", role: "SURETY", active: true },
  ])

  it("round-trips through the stored JSON in signing order, roles restored", () => {
    const stored: unknown = JSON.parse(JSON.stringify(preparedSignerSet(required)))
    expect(stored).toEqual([
      { clientId: "c-director", document: "AGREEMENT" }, { clientId: "c-director", document: "RESOLUTION" },
      { clientId: "c-surety", document: "SURETYSHIP" },
    ])
    expect(requiredFromPrepared(stored)).toEqual(required)
  })

  it("refuses a malformed value", () => {
    expect(() => requiredFromPrepared({})).toThrow(TypeError)
    expect(() => requiredFromPrepared([{ clientId: "c", document: "LEASE" }])).toThrow(TypeError)
    expect(() => requiredFromPrepared([{ document: "AGREEMENT" }])).toThrow(TypeError)
  })
})

describe("agreement section 5 prints the signed arrears terms as data", () => {
  const text = async (data: ReturnType<typeof syntheticDealDocumentData>) => {
    const pages = await pdfPageContents(await renderInstalmentSaleAgreement(data))
    return pages.flatMap((c) => [...c.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1"))).join(" ")
  }

  it("the margin over the contract rate and the collection fee", async () => {
    const all = await text(syntheticDealDocumentData())
    expect(all).toContain("Default interest on arrears")
    expect(all).toContain("Contract rate plus 2.00% a year")
    expect(all).toContain("Collection fee per missed instalment")
    expect(all).toContain("R 450.00")
  })

  it("distinguishes disabled default interest from a zero added margin", async () => {
    const base = syntheticDealDocumentData()
    const disabled = await text({ ...base, pricing: { ...base.pricing, arrearsMarginRate: null, collectionFeeCents: 0 } })
    const zeroMargin = await text({ ...base, pricing: { ...base.pricing, arrearsMarginRate: "0", collectionFeeCents: 0 } })
    expect(disabled).toContain("Default interest on arrears None")
    expect(zeroMargin).toContain("Contract rate (no added margin)")
    expect(disabled).not.toContain("R 450.00")
  })
})

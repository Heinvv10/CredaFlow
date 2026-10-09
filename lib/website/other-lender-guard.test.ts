import { describe, expect, it } from "vitest"
import { findOtherLender, MAX_WINDOW, OTHER_LENDER_DIGESTS, sha256, tokens } from "./__fixtures__/other-lender"

// The forked-lender guard matches by digest, and the digests live outside the
// repository (see the fixture). These tests prove the mechanism on a synthetic
// identity; when the digests file is present its shape and count are pinned,
// so dropping or corrupting a digest goes red here.

const SYNTHETIC = ["acme lending", "ncrcp99999", "2020 123456 07", "555 0100"].map(sha256)

describe("forked-lender guard", () => {
  it("normalises case and every non-alphanumeric separator", () => {
    expect(tokens("Acme-Lending (Pty) Ltd, info@acme.example")).toEqual(["acme", "lending", "pty", "ltd", "info", "acme", "example"])
    for (const s of ["Acme Lending", "ACME-LENDING", "acme_lending", "acme.lending", "<b>Acme</b> <i>Lending</i>"]) {
      expect(findOtherLender(s, SYNTHETIC), s).toEqual(["acme lending"])
    }
  })

  it("matches 1-, 2- and 3-token windows anywhere in the text", () => {
    expect(findOtherLender("NCR Reg: NCRCP99999 · FSP", SYNTHETIC)).toEqual(["ncrcp99999"])
    expect(findOtherLender("Reg. No. 2020/123456/07.", SYNTHETIC)).toEqual(["2020 123456 07"])
    expect(findOtherLender("call +27 11 555 0100 today", SYNTHETIC)).toEqual(["555 0100"])
    expect(findOtherLender(`<a href="tel:+27115550100">call</a>`, [sha256("27115550100")])).toEqual(["27115550100"])
    expect(MAX_WINDOW).toBe(3)
  })

  it("splits identifiers at camelCase and letter/digit boundaries", () => {
    expect(findOtherLender("const acmeLendingTheme = 1", SYNTHETIC)).toEqual(["acme lending"])
    expect(findOtherLender("AcmeLending2026", SYNTHETIC)).toEqual(["acme lending"])
  })

  it("matches a whole phone number in any digit grouping", () => {
    const line = [sha256("0115550100"), sha256("27115550100")]
    for (const s of ["+27 115 550 100", "011-555-01-00", "(011) 5550 100", "tel:+2711 555 0100", "x 2 7 1 1 5 5 5 0 1 0 0"]) {
      expect(findOtherLender(s, line).length, s).toBeGreaterThan(0)
    }
    expect(findOtherLender("011 555 0199", line)).toEqual([])
  })

  it("does not match a different or merged token", () => {
    expect(findOtherLender("acmelending ncrcp999990 2020/123456/08 555 01000", SYNTHETIC)).toEqual([])
    expect(findOtherLender("", SYNTHETIC)).toEqual([])
  })

  it.skipIf(!OTHER_LENDER_DIGESTS)("the digests file is complete and well-formed", () => {
    const all = Object.values(OTHER_LENDER_DIGESTS!).flat()
    for (const d of all) expect(d).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(all).size).toBe(all.length)
    expect(Object.fromEntries(Object.entries(OTHER_LENDER_DIGESTS!).map(([k, v]) => [k, v.length])))
      .toEqual({ brand: 4, registration: 4, address: 2, phone: 9, host: 1 })
  })

  it("defaults to the stored list", () => {
    expect(findOtherLender("Acme Lending NCRCP99999")).toEqual([])
  })
})

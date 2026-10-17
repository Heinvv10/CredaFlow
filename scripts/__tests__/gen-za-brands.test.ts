import { describe, expect, it } from "vitest"
import { keep, variants } from "../gen-za-brands"

describe("gen-za-brands", () => {
  it("writes a brand as statements print it: upper-case, no accents or parentheses, apostrophe kept, dropped and spaced", () => {
    expect(variants("Galito's")).toEqual(expect.arrayContaining(["GALITOS", "GALITO S"]))
    expect(variants("Vida e Caffè")).toContain("VIDA E CAFFE")
    expect(variants("Shoe City (Southern Africa)")).toContain("SHOE CITY")
    expect(variants("Pick n Pay")).toContain("PICKNPAY")
  })

  it("matches a long name by the three words a statement key keeps, never ending on '&'", () => {
    expect(variants("Blue Bottle Liquors Express")).toContain("BLUE BOTTLE LIQUORS")
    expect(variants("Tiger Wheel & Tyre")).toContain("TIGER WHEEL")
    expect(variants("Tiger Wheel & Tyre")).not.toContain("TIGER WHEEL &")
  })

  it("drops short names, ordinary one-word English words and generic two-word names", () => {
    const english = new Set(["code", "rage"])
    expect(keep("CODE", english)).toBe(false)
    expect(keep("PNA", english)).toBe(false)
    expect(keep("TRUCK STOP", english)).toBe(false)
    expect(keep("FOOTGEAR", english)).toBe(true)
    expect(keep("RAGE SHOES", english)).toBe(true)
  })
})

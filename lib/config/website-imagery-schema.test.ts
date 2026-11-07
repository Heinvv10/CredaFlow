import { describe, expect, it } from "vitest"
import {
  ALL_SLOTS,
  getSlotImage,
  isEmptyImagery,
  parseSlot,
  parseWebsiteImagery,
  slotTextSchema,
  websiteImagerySchema,
  withSlot,
} from "./website-imagery-schema"

const HASH = "a".repeat(64)
const image = (alt = "Two people at a kitchen table") => ({ sha256: HASH, format: "jpeg" as const, width: 1600, height: 900, alt })
const community = { ...image("A market street"), heading: "Part of the community", body: "We lend to the people we live next to." }

describe("websiteImagerySchema", () => {
  it("accepts hero, product images and a community band", () => {
    const doc = { hero: image(), products: { personal: image(), "short-term": image() }, community }
    expect(websiteImagerySchema.parse(doc)).toEqual(doc)
  })

  it("accepts an empty document", () => {
    expect(websiteImagerySchema.parse({})).toEqual({})
  })

  it.each([
    ["an unknown top-level slot", { banner: image() }],
    ["an unknown product slot", { products: { mortgage: image() } }],
    ["an unknown field on an image", { hero: { ...image(), href: "https://evil.example" } }],
    ["a hero with no alt text", { hero: { ...image(), alt: undefined } }],
    ["a hero with blank alt text", { hero: { ...image(), alt: "   " } }],
    ["a product image with no alt text", { products: { personal: { ...image(), alt: "" } } }],
    ["alt text over 200 characters", { hero: image("x".repeat(201)) }],
    ["a community band with no heading", { community: { ...community, heading: undefined } }],
    ["a community band with no sentence", { community: { ...community, body: "" } }],
    ["a community sentence over 240 characters", { community: { ...community, body: "x".repeat(241) } }],
    ["a hash that is not a sha256", { hero: { ...image(), sha256: "../../etc/passwd" } }],
    ["a format outside JPEG, PNG and WebP", { hero: { ...image(), format: "gif" } }],
  ])("rejects %s", (_what, doc) => {
    expect(websiteImagerySchema.safeParse(doc).success).toBe(false)
  })
})

describe("parseWebsiteImagery", () => {
  it("is null for an empty column and for stored data that no longer matches", () => {
    expect(parseWebsiteImagery(null)).toBeNull()
    expect(parseWebsiteImagery(undefined)).toBeNull()
    expect(parseWebsiteImagery({ banner: image() })).toBeNull()
    expect(parseWebsiteImagery("hero")).toBeNull()
  })
})

describe("slots", () => {
  it("names hero, community and one per product", () => {
    expect([...ALL_SLOTS]).toEqual(["hero", "product-short-term", "product-personal", "product-purchase-order", "product-invoice-discounting", "community"])
    expect(parseSlot("product-personal")).toBe("product-personal")
    expect(parseSlot("product-mortgage")).toBeNull()
    expect(parseSlot("../hero")).toBeNull()
  })

  it("sets and clears a slot, and is empty once the last one goes", () => {
    const withHero = withSlot(null, "hero", image())
    const both = withSlot(withHero, "product-personal", image("Card"))
    expect(getSlotImage(both, "product-personal")?.alt).toBe("Card")
    expect(getSlotImage(both, "hero")?.alt).toBe("Two people at a kitchen table")
    const noHero = withSlot(both, "hero", undefined)
    expect(noHero).toEqual({ products: { personal: image("Card") } })
    expect(withSlot(noHero, "product-personal", undefined)).toBeNull()
    expect(isEmptyImagery(withSlot(null, "community", undefined))).toBe(true)
  })
})

describe("slotTextSchema", () => {
  it("requires alt text and refuses other fields", () => {
    expect(slotTextSchema.safeParse({}).success).toBe(false)
    expect(slotTextSchema.safeParse({ alt: "  " }).success).toBe(false)
    expect(slotTextSchema.safeParse({ alt: "ok", tenantId: "t2" }).success).toBe(false)
    expect(slotTextSchema.parse({ alt: "  ok  " })).toEqual({ alt: "ok" })
  })
})

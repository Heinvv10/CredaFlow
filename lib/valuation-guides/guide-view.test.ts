import { describe, expect, it } from "vitest"
import { clampOffset } from "./guide-view"

describe("clampOffset (the guide rows page's ?offset)", () => {
  it("reads a whole number within the guide's rows, else 0 or the last row", () => {
    expect(clampOffset("200", 450)).toBe(200)
    expect(clampOffset(undefined, 450)).toBe(0)
    expect(clampOffset(["400", "1"], 450)).toBe(400)
    expect(clampOffset("-5", 450)).toBe(0)
    expect(clampOffset("2.5", 450)).toBe(0)
    expect(clampOffset("abc", 450)).toBe(0)
    expect(clampOffset("1e21", 450)).toBe(450)
    expect(clampOffset("9999", 450)).toBe(450)
  })
})

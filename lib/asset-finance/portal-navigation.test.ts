import { describe, expect, it } from "vitest"
import { portalBusinessLinkVisible } from "./portal-navigation"

describe("portalBusinessLinkVisible", () => {
  it.each([
    [false, 1, 1, false],
    [true, 1, 0, true],
    [true, 0, 1, true],
    [true, 0, 0, false],
  ])("feature=%s entities=%s signers=%s => %s", (feature, entities, signers, expected) => {
    expect(portalBusinessLinkVisible(feature, entities, signers)).toBe(expected)
  })
})

import { describe, expect, it } from "vitest"
import { ATMOS_PLATES, pickPlates } from "./quote-atmosphere"
import { QUICKQUOTE_VIEWS } from "./quickquote-config"

/* The photographic plates were the forked lender's own artwork and are gone.
   The list is empty until a tenant supplies its own; every consumer must cope
   with that, because a plate that is named but missing paints a broken-image
   icon across the page. */
describe("ATMOS_PLATES", () => {
  it("names no photograph for any view", () => {
    for (const view of QUICKQUOTE_VIEWS) {
      expect(ATMOS_PLATES[view]).toEqual([])
    }
  })
})

describe("pickPlates", () => {
  it("picks nothing, so no image is requested", () => {
    expect(pickPlates(() => 0)).toEqual({})
    expect(pickPlates(() => 0.99)).toEqual({})
  })

  it.each([1, 1.5, -0.2, Number.NaN])("stays empty for the source value %p", (value) => {
    expect(pickPlates(() => value)).toEqual({})
  })
})

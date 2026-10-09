import { describe, it, expect } from "vitest"
import { toCrumbs } from "./breadcrumbs"

describe("toCrumbs", () => {
  it("maps name/path to label/href", () => {
    const out = toCrumbs([
      { name: "Home", path: "/" },
      { name: "Products", path: "/site/products" },
      { name: "Credit", path: "/site/products/credit" },
    ])
    expect(out[0]).toEqual({ label: "Home", href: "/" })
    expect(out[1]).toEqual({ label: "Products", href: "/site/products" })
  })

  it("drops href on the last (current-page) crumb", () => {
    const out = toCrumbs([
      { name: "Home", path: "/" },
      { name: "Credit", path: "/site/products/credit" },
    ])
    expect(out[out.length - 1]).toEqual({ label: "Credit" })
    expect(out[out.length - 1].href).toBeUndefined()
  })

  it("returns [] for empty input", () => {
    expect(toCrumbs([])).toEqual([])
  })
})

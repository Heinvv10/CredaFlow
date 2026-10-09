import { describe, expect, it } from "vitest"
import { DEFAULT_TENANT_COLOURS, tenantColourErrors } from "./tenant-colours"

const GOOD = { primaryColor: "#1F4E79", secondaryColor: "#245E92", darkColor: "#0F1115" }

describe("tenantColourErrors", () => {
  it("accepts the defaults and a known-good set", () => {
    expect(tenantColourErrors(DEFAULT_TENANT_COLOURS)).toEqual({})
    expect(tenantColourErrors(GOOD)).toEqual({})
  })

  it("refuses a yellow primary: brand text on light surfaces falls below 4.5:1", () => {
    const errors = tenantColourErrors({ ...GOOD, primaryColor: "#FFD700" })
    expect(Object.keys(errors)).toEqual(["primaryColor"])
    expect(errors.primaryColor).toMatch(/^light: --cf-[a-z-]+ on --cf-[a-z-]+ is \d+\.\d\d:1, below 4\.5:1$/)
  })

  it("refuses a light darkColor: dark-mode text on the page background falls below 4.5:1", () => {
    const errors = tenantColourErrors({ ...GOOD, darkColor: "#C0C0C0" })
    expect(Object.keys(errors)).toEqual(["darkColor"])
    expect(errors.darkColor).toMatch(/^dark: --cf-[a-z-]+ on --cf-bg is /)
  })

  it("refuses a value that is not #rrggbb, before measuring anything", () => {
    for (const bad of ["red", "#fff", "#12345g", "#1F4E79;}body{display:none", " #1F4E79", ""]) {
      expect(tenantColourErrors({ ...GOOD, secondaryColor: bad })).toEqual({ secondaryColor: "must be a #rrggbb hex colour" })
    }
    expect(tenantColourErrors({ ...GOOD, primaryColor: 42 as unknown as string })).toEqual({ primaryColor: "must be a #rrggbb hex colour" })
  })

  it("reports every failing field", () => {
    expect(Object.keys(tenantColourErrors({ primaryColor: "#FFD700", secondaryColor: "#FFFF00", darkColor: "#C0C0C0" })).sort())
      .toEqual(["darkColor", "primaryColor", "secondaryColor"])
  })
})

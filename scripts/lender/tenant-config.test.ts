import { describe, expect, it } from "vitest"
import { parseTenantConfig } from "./tenant-config"
import { validFile } from "./tenant-config.test-helpers"

const errorsOf = (raw: unknown) => {
  const r = parseTenantConfig(raw)
  return r.ok ? [] : r.errors
}

describe("parseTenantConfig", () => {
  it("accepts a minimal file and fills colour and feature defaults", () => {
    const r = parseTenantConfig(validFile())
    if (!r.ok) throw new Error(r.errors.join("; "))
    expect(r.config.slug).toBe("staging-lender")
    expect(r.config.domain).toBeNull()
    expect(r.config.features).toMatchObject({ featureLms: true, featureCrm: false, featurePortal: true })
    expect(r.config.colours.primaryColor).toMatch(/^#[0-9a-f]{6}$/i)
    expect(r.config.identity.ncrNumber).toBe("NCRCP99999")
  })

  it("applies feature overrides to the matching column", () => {
    const r = parseTenantConfig({ ...validFile(), features: { crm: true, portal: false } })
    if (!r.ok) throw new Error("rejected")
    expect(r.config.features).toMatchObject({ featureCrm: true, featurePortal: false })
  })

  it("rejects an identity the app's own schema rejects, naming the field", () => {
    const f = validFile()
    f.identity.ncrNumber = "NCR-1"
    f.statutoryConfirm.ncrNumber = "NCR-1"
    expect(errorsOf(f).join("\n")).toMatch(/identity\.ncrNumber/)
  })

  it("rejects a statutory number whose confirmation differs", () => {
    const f = validFile()
    f.statutoryConfirm.companyRegNumber = "2020/123457/07"
    expect(errorsOf(f)).toEqual(["statutoryConfirm.companyRegNumber: must repeat identity.companyRegNumber exactly"])
  })

  it("rejects a missing confirmation block", () => {
    const { statutoryConfirm: _omit, ...rest } = validFile()
    expect(errorsOf(rest).join("\n")).toMatch(/statutoryConfirm/)
  })

  it("accepts a confirmation that differs only in case and padding", () => {
    const f = validFile()
    f.statutoryConfirm.ncrNumber = " ncrcp99999 "
    expect(parseTenantConfig(f).ok).toBe(true)
  })

  it("rejects colours that fail the contrast check", () => {
    expect(errorsOf({ ...validFile(), colours: { primaryColor: "#ffffff", secondaryColor: "#ffffff", darkColor: "#ffffff" } }).join("\n")).toMatch(/colours\./)
  })

  it("rejects unknown top-level keys, identity keys and feature flags", () => {
    expect(errorsOf({ ...validFile(), extra: 1 })).not.toHaveLength(0)
    const f = validFile()
    Object.assign(f.identity, { nope: "x" })
    expect(errorsOf(f).join("\n")).toMatch(/unknown field/)
    expect(errorsOf({ ...validFile(), features: { teleport: true } })).not.toHaveLength(0)
  })

  it("rejects a bad slug and a bad domain", () => {
    expect(errorsOf({ ...validFile(), slug: "Bad Slug" }).join("\n")).toMatch(/slug/)
    expect(errorsOf({ ...validFile(), domain: "https://x.example/" }).join("\n")).toMatch(/domain/)
  })
})

describe("lender.example.json", () => {
  it("passes the same validation the CLI applies", async () => {
    const { readFileSync } = await import("node:fs")
    const r = parseTenantConfig(JSON.parse(readFileSync(`${__dirname}/lender.example.json`, "utf8")))
    expect(r.ok).toBe(true)
  })
})

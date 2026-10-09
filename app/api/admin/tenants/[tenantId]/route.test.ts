import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { authMock, findUnique, update, configBefore, transaction, logAuditStrict, revalidateTag } = vi.hoisted(() => ({
  revalidateTag: vi.fn(),
  authMock: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  configBefore: vi.fn(),
  transaction: vi.fn(),
  logAuditStrict: vi.fn(),
}))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("@/lib/prisma", () => ({ prisma: { tenant: { findUnique, update }, $transaction: transaction } }))
vi.mock("@/lib/audit", () => ({
  logAuditStrict,
  AuditAction: { BUREAU_CONFIG_UPDATED: "BUREAU_CONFIG_UPDATED", TENANT_COLOURS_UPDATED: "TENANT_COLOURS_UPDATED" },
}))
vi.mock("next/cache", () => ({ revalidateTag }))
vi.mock("@/lib/bureau-submission/generate", () => ({ SUPPLIER_NUMBER: /^[A-Z0-9]{1,10}$/ }))

import { PATCH } from "./route"

// Covers only the bureau-submission fields this route gained. They decide
// whether real people's loans are reported to a credit bureau, so they are
// validated and their change is audited.

const patch = (body: unknown) => PATCH(
  new NextRequest("http://localhost/api/admin/tenants/t1", {
    method: "PATCH", headers: { "x-admin-secret": "s3cret" }, body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ tenantId: "t1" }) },
)
const configWritten = () => update.mock.calls[0][0].data.config.upsert.update

describe("PATCH /api/admin/tenants/[tenantId] — bureau submission fields", () => {
  beforeEach(() => {
    process.env.ADMIN_SECRET = "s3cret"
    authMock.mockReset().mockResolvedValue({ user: { id: "u1", email: "root@test.invalid", role: "SUPER_ADMIN" } })
    findUnique.mockReset().mockResolvedValue({ id: "t1" })
    update.mockReset().mockResolvedValue({ id: "t1", config: {} })
    configBefore.mockReset().mockResolvedValue({ featureBureauSubmission: false, bureauSupplierNumber: null, bureauTradingName: "Old Name", bureauReportingStartDate: new Date("2026-06-01T00:00:00.000Z") })
    // The transaction client: the update and the audit row must both go through it.
    transaction.mockReset().mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ tenant: { update }, tenantConfig: { findUnique: configBefore }, isTx: true }))
    logAuditStrict.mockReset().mockResolvedValue(undefined)
  })

  it("writes valid values, normalised, and audits the change", async () => {
    const response = await patch({
      featureBureauSubmission: true, bureauSupplierNumber: " tt0109 ", bureauTradingName: " Acme Lending ", bureauReportingStartDate: "2026-11-01",
    })
    expect(response.status).toBe(200)
    expect(configWritten()).toEqual({
      featureBureauSubmission: true,
      bureauSupplierNumber: "TT0109",
      bureauTradingName: "Acme Lending",
      bureauReportingStartDate: new Date("2026-11-01T00:00:00.000Z"),
    })
    expect(logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t1", userId: "u1", action: "BUREAU_CONFIG_UPDATED", entity: "TenantConfig",
      oldValue: { featureBureauSubmission: false, bureauSupplierNumber: null, bureauTradingName: "Old Name", bureauReportingStartDate: "2026-06-01" },
      newValue: { featureBureauSubmission: true, bureauSupplierNumber: "TT0109", bureauTradingName: "Acme Lending", bureauReportingStartDate: "2026-11-01" },
    }), expect.objectContaining({ isTx: true }))
  })

  it("fails the request when the audit row cannot be written, from inside the transaction", async () => {
    // The mocked transaction cannot show a rollback; it shows that the audit
    // failure propagates out of the same callback the update ran in.
    logAuditStrict.mockRejectedValue(new Error("audit down"))
    await expect(patch({ featureBureauSubmission: true })).rejects.toThrow("audit down")
    expect(transaction).toHaveBeenCalledTimes(1)
  })

  it("accepts a trading name the generator can clean, such as one with brackets", async () => {
    expect((await patch({ bureauTradingName: "Acme Lending (Pty) Ltd" })).status).toBe(200)
    expect(configWritten()).toEqual({ bureauTradingName: "Acme Lending (Pty) Ltd" })
  })

  it("clears a value with null", async () => {
    expect((await patch({ bureauSupplierNumber: null, bureauReportingStartDate: null })).status).toBe(200)
    expect(configWritten()).toEqual({ bureauSupplierNumber: null, bureauReportingStartDate: null })
  })

  it.each([
    [{ bureauSupplierNumber: 'TT"; x=' }],
    [{ bureauSupplierNumber: "TT\r\n0109" }],
    [{ bureauSupplierNumber: "ABCDEFGHIJK" }],
    [{ bureauSupplierNumber: "" }],
    [{ bureauTradingName: "Acme\r\nT000000002" }],
    [{ bureauTradingName: "()" }],
    [{ bureauTradingName: "x".repeat(61) }],
    [{ bureauReportingStartDate: "01/11/2026" }],
    [{ bureauReportingStartDate: "2026-02-30" }],
    [{ featureBureauSubmission: "true" }],
  ])("refuses %j with 400 and writes nothing", async (body) => {
    expect((await patch(body)).status).toBe(400)
    expect(update).not.toHaveBeenCalled()
    expect(logAuditStrict).not.toHaveBeenCalled()
  })

  it("does not write an audit row when no audited field changed", async () => {
    expect((await patch({ featureReports: true })).status).toBe(200)
    expect(logAuditStrict).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })

  // The only identity write path is PUT /api/settings/identity.
  it.each([
    [{ ncrNumber: "NCRCP99999" }],
    [{ brandName: "Acme Lending" }],
    [{ fscaNumber: "12345" }],
    [{ companyRegNumber: "2020/123456/07" }],
    [{ legalName: "Acme Lending (Pty) Ltd" }],
    [{ ncrStatus: "Registered" }],
    // The letterhead logo is uploaded, validated and audited in Settings →
    // Lender identity; a URL written here would never be fetched anyway.
    [{ logoUrl: "/logo.svg" }],
    [{ logoUrl: "https://evil.example/logo.png" }],
  ])("refuses lender identity field %j with 400 and writes nothing", async (body) => {
    expect((await patch(body)).status).toBe(400)
    expect(update).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })

  it("is refused without the super-admin session and the admin secret", async () => {
    authMock.mockResolvedValue({ user: { id: "u1", role: "ADMIN" } })
    expect((await patch({ featureBureauSubmission: true })).status).toBe(403)
    expect(update).not.toHaveBeenCalled()
  })
})

describe("PATCH /api/admin/tenants/[tenantId] — tenant colours", () => {
  const GOOD = { primaryColor: "#1F4E79", secondaryColor: "#245E92", darkColor: "#0F1115" }

  beforeEach(() => {
    process.env.ADMIN_SECRET = "s3cret"
    authMock.mockReset().mockResolvedValue({ user: { id: "u1", email: "root@test.invalid", role: "SUPER_ADMIN" } })
    findUnique.mockReset().mockResolvedValue({ id: "t1", config: GOOD })
    update.mockReset().mockResolvedValue({ id: "t1", config: {} })
    configBefore.mockReset().mockResolvedValue(GOOD)
    transaction.mockReset().mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ tenant: { update }, tenantConfig: { findUnique: configBefore }, isTx: true }))
    logAuditStrict.mockReset().mockResolvedValue(undefined)
    revalidateTag.mockReset()
  })

  it("saves a passing set, audits it in the same transaction and invalidates the cached config", async () => {
    const response = await patch({ primaryColor: "#7A3E1D", darkColor: "#101418" })
    expect(response.status).toBe(200)
    expect(configWritten()).toEqual({ primaryColor: "#7A3E1D", darkColor: "#101418" })
    expect(logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t1", userId: "u1", action: "TENANT_COLOURS_UPDATED", entity: "TenantConfig",
      oldValue: { primaryColor: "#1F4E79", darkColor: "#0F1115" },
      newValue: { primaryColor: "#7A3E1D", darkColor: "#101418" },
    }), expect.objectContaining({ isTx: true }))
    expect(revalidateTag).toHaveBeenCalledWith("tenant-config-t1", { expire: 0 })
  })

  it("still reports the committed save when the cache cannot be invalidated", async () => {
    revalidateTag.mockImplementation(() => { throw new Error("no cache store") })
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined)
    expect((await patch({ primaryColor: "#7A3E1D" })).status).toBe(200)
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("not invalidated"), expect.any(Error))
    errorLog.mockRestore()
  })

  it("measures a tenant with no config row against the default colours", async () => {
    findUnique.mockResolvedValue({ id: "t1", config: null })
    expect((await patch({ darkColor: "#101418" })).status).toBe(200)
    findUnique.mockResolvedValue({ id: "t1", config: null })
    expect(Object.keys((await (await patch({ darkColor: "#C0C0C0" })).json()).fields)).toEqual(["darkColor"])
  })

  it.each([
    ["a yellow primary", { primaryColor: "#FFD700" }, "primaryColor", /^light: /],
    ["a light darkColor", { darkColor: "#C0C0C0" }, "darkColor", /^dark: .* on --cf-bg /],
    ["a non-hex string", { secondaryColor: "teal" }, "secondaryColor", /^must be a #rrggbb hex colour$/],
    ["CSS smuggled into a colour", { primaryColor: "#1F4E79;}body{display:none" }, "primaryColor", /^must be a #rrggbb/],
    ["null", { darkColor: null }, "darkColor", /^must be a #rrggbb/],
  ])("refuses %s with 422, a field-level reason, and writes nothing", async (_label, body, field, reason) => {
    const response = await patch(body)
    expect(response.status).toBe(422)
    const json = await response.json()
    expect(Object.keys(json.fields)).toEqual([field])
    expect(json.fields[field]).toMatch(reason)
    expect(update).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
    expect(logAuditStrict).not.toHaveBeenCalled()
  })

  it("checks a single colour against the tenant's other saved colours", async () => {
    // The saved primary is part of the set measured, not the default one.
    findUnique.mockResolvedValue({ id: "t1", config: { ...GOOD, primaryColor: "#FFD700" } })
    const response = await patch({ secondaryColor: "#245E92" })
    expect(response.status).toBe(422)
    expect(Object.keys((await response.json()).fields)).toEqual(["primaryColor"])
  })
})

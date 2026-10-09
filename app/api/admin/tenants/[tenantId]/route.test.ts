import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { authMock, findUnique, update, configBefore, transaction, logAuditStrict } = vi.hoisted(() => ({
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
  AuditAction: { BUREAU_CONFIG_UPDATED: "BUREAU_CONFIG_UPDATED" },
}))
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

  it("does not write an audit row when no bureau field changed", async () => {
    expect((await patch({ primaryColor: "#123456" })).status).toBe(200)
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

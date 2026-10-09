/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const updateSettingsMock = vi.fn()
const getSettingsMock = vi.fn()
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }) }))
vi.mock("@/lib/inbox/settings", () => ({ getCommsSettings: (t: unknown) => getSettingsMock(t), updateCommsSettings: (t: unknown, p: unknown) => updateSettingsMock(t, p) }))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))

import { PATCH, DELETE } from "./route"
import { logAudit } from "@/lib/audit"

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "ADMIN" } })
})

function patch(body: unknown) {
  return PATCH(new NextRequest("http://x/api/settings/whatsapp", { method: "PATCH", body: JSON.stringify(body) }))
}

it("persists provider + WABA credentials and audits which fields changed", async () => {
  updateSettingsMock.mockResolvedValue({ id: "s1", waProvider: "WA_CLOUD" })
  const res = await patch({ waProvider: "WA_CLOUD", wabaPhoneNumberId: "PN1", wabaAccessToken: "TOK" })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, waProvider: "WA_CLOUD" })
  expect(updateSettingsMock).toHaveBeenCalledWith("t1", { waProvider: "WA_CLOUD", wabaPhoneNumberId: "PN1", wabaAccessToken: "TOK" })
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "COMMS_SETTINGS_UPDATED", entity: "CommsSettings" }))
})

it("audits a chatAlertEmail change with its old and new value, as stored", async () => {
  getSettingsMock.mockResolvedValue({ id: "s1", chatAlertEmail: "old@acme-lending.example" })
  updateSettingsMock.mockResolvedValue({ id: "s1", waProvider: "WA_CLOUD", chatAlertEmail: "comms@acme-lending.example" })
  const res = await patch({ chatAlertEmail: "  comms@acme-lending.example " })
  expect(res.status).toBe(200)
  expect(updateSettingsMock).toHaveBeenCalledWith("t1", { chatAlertEmail: "  comms@acme-lending.example " })
  expect(getSettingsMock.mock.invocationCallOrder[0]).toBeLessThan(updateSettingsMock.mock.invocationCallOrder[0])
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
    oldValue: { chatAlertEmail: "old@acme-lending.example" },
    newValue: { updatedFields: ["chatAlertEmail"], waProvider: "WA_CLOUD", chatAlertEmail: "comms@acme-lending.example" },
  }))
})

it("a patch that does not touch chatAlertEmail audits no address, old or new", async () => {
  updateSettingsMock.mockResolvedValue({ id: "s1", waProvider: "WA_CLOUD", chatAlertEmail: "comms@acme-lending.example" })
  await patch({ waProvider: "WA_CLOUD" })
  const audit = vi.mocked(logAudit).mock.calls[0][0]
  expect(audit.oldValue).toBeUndefined()
  expect(audit.newValue).toEqual({ updatedFields: ["waProvider"], waProvider: "WA_CLOUD" })
})

it("maps an invalid chatAlertEmail error to 400 without auditing", async () => {
  updateSettingsMock.mockRejectedValue(new Error("invalid chatAlertEmail"))
  const res = await patch({ chatAlertEmail: "not-an-email" })
  expect(res.status).toBe(400)
  expect(logAudit).not.toHaveBeenCalled()
})

it("never echoes credential values in the response or audit payload", async () => {
  updateSettingsMock.mockResolvedValue({ id: "s1", waProvider: "WA_CLOUD" })
  const res = await patch({ waProvider: "WA_CLOUD", wabaAccessToken: "SECRET-TOK", wabaAppSecret: "SECRET-APP" })
  const bodyText = JSON.stringify(await res.json())
  expect(bodyText).not.toContain("SECRET-TOK")
  expect(bodyText).not.toContain("SECRET-APP")
  const auditArg = JSON.stringify(vi.mocked(logAudit).mock.calls[0]?.[0])
  expect(auditArg).not.toContain("SECRET-TOK")
  expect(auditArg).not.toContain("SECRET-APP")
})

it("maps an invalid provider error to 400 without auditing", async () => {
  updateSettingsMock.mockRejectedValue(new Error("invalid waProvider: PIGEON"))
  const res = await patch({ waProvider: "PIGEON" })
  expect(res.status).toBe(400)
  expect(logAudit).not.toHaveBeenCalled()
})

it("is ADMIN-guarded and short-circuits without calling updateCommsSettings", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
  const res = await patch({ waProvider: "WA_CLOUD" })
  expect(res.status).toBe(403)
  expect(updateSettingsMock).not.toHaveBeenCalled()
})

it("rejects a non-object body with 400", async () => {
  const res = await PATCH(new NextRequest("http://x/api/settings/whatsapp", { method: "PATCH", body: "not-json" }))
  expect(res.status).toBe(400)
  expect(updateSettingsMock).not.toHaveBeenCalled()
})

it("DELETE disconnects: reverts provider and nulls all WABA fields", async () => {
  updateSettingsMock.mockResolvedValue({ id: "s1", waProvider: "WA_UNOFFICIAL" })
  const res = await DELETE(new NextRequest("http://x/api/settings/whatsapp", { method: "DELETE" }))
  expect(res.status).toBe(200)
  expect(updateSettingsMock).toHaveBeenCalledWith("t1", expect.objectContaining({
    waProvider: "WA_UNOFFICIAL",
    wabaId: null, wabaPhoneNumberId: null, wabaAccessToken: null,
    wabaAppSecret: null, wabaBusinessId: null, wabaVerifyToken: null,
  }))
})

it("DELETE is ADMIN-guarded", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
  const res = await DELETE(new NextRequest("http://x/api/settings/whatsapp", { method: "DELETE" }))
  expect(res.status).toBe(403)
  expect(updateSettingsMock).not.toHaveBeenCalled()
})

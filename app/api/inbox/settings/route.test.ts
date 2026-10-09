/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireCommsAgentMock = vi.fn()
const requireApiRoleMock = vi.fn()
const getSettingsMock = vi.fn()
const updateSettingsMock = vi.fn()
vi.mock("@/lib/inbox/authz", () => ({ requireCommsAgent: () => requireCommsAgentMock() }))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }) }))
vi.mock("@/lib/inbox/settings", () => ({
  INVALID_CHAT_ALERT_EMAIL: "invalid chatAlertEmail",
  getCommsSettings: (a: unknown) => getSettingsMock(a), updateCommsSettings: (t: unknown, p: unknown) => updateSettingsMock(t, p),
}))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))

import { GET, PUT } from "./route"
import { logAudit } from "@/lib/audit"
beforeEach(() => {
  vi.clearAllMocks()
  requireCommsAgentMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "ADMIN" } })
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "ADMIN" } })
  getSettingsMock.mockResolvedValue({ id: "s1", whatsappEnabled: false })
})

it("GET returns the settings row", async () => {
  getSettingsMock.mockResolvedValue({ id: "s1", whatsappEnabled: false })
  const res = await GET(new NextRequest("http://x/api/inbox/settings"))
  expect(res.status).toBe(200)
  expect(getSettingsMock).toHaveBeenCalledWith("t1")
})

it("PUT updates via updateCommsSettings and audits the change", async () => {
  updateSettingsMock.mockResolvedValue({ id: "s1", whatsappEnabled: true })
  const res = await PUT(new NextRequest("http://x/api/inbox/settings", { method: "PUT", body: JSON.stringify({ whatsappEnabled: true }) }))
  expect(res.status).toBe(200)
  expect(updateSettingsMock).toHaveBeenCalledWith("t1", { whatsappEnabled: true })
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "COMMS_SETTINGS_UPDATED", entity: "CommsSettings" }))
})

it("PUT audits a chatAlertEmail change with its old and new value", async () => {
  getSettingsMock.mockResolvedValue({ id: "s1", chatAlertEmail: null })
  updateSettingsMock.mockResolvedValue({ id: "s1", chatAlertEmail: "comms@acme-lending.example" })
  const res = await PUT(new NextRequest("http://x/api/inbox/settings", { method: "PUT", body: JSON.stringify({ chatAlertEmail: "comms@acme-lending.example" }) }))
  expect(res.status).toBe(200)
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
    oldValue: { chatAlertEmail: null },
    newValue: { chatAlertEmail: "comms@acme-lending.example" },
  }))
})

it("PUT maps an invalid provider error to 400 without auditing", async () => {
  updateSettingsMock.mockRejectedValue(new Error("invalid waProvider: PIGEON"))
  const res = await PUT(new NextRequest("http://x/api/inbox/settings", { method: "PUT", body: JSON.stringify({ waProvider: "PIGEON" }) }))
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "invalid waProvider: PIGEON" })
  expect(logAudit).not.toHaveBeenCalled()
})

it("PUT answers an invalid alert email with a message for that field, without auditing", async () => {
  updateSettingsMock.mockRejectedValue(new Error("invalid chatAlertEmail"))
  const res = await PUT(new NextRequest("http://x/api/inbox/settings", { method: "PUT", body: JSON.stringify({ chatAlertEmail: "not-an-email" }) }))
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "invalid chatAlertEmail", errors: { chatAlertEmail: "Enter a valid email address." } })
  expect(logAudit).not.toHaveBeenCalled()
})

it("PUT is ADMIN-guarded", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
  const res = await PUT(new NextRequest("http://x/api/inbox/settings", { method: "PUT", body: JSON.stringify({ whatsappEnabled: true }) }))
  expect(res.status).toBe(403)
})

it("GET short-circuits on guard failure without calling getCommsSettings", async () => {
  const { NextResponse } = await import("next/server")
  requireCommsAgentMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
  const res = await GET(new NextRequest("http://x/api/inbox/settings"))
  expect(res.status).toBe(403)
  expect(getSettingsMock).not.toHaveBeenCalled()
})

it("PUT short-circuits on guard failure without calling updateCommsSettings", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
  const res = await PUT(new NextRequest("http://x/api/inbox/settings", { method: "PUT", body: JSON.stringify({ whatsappEnabled: true }) }))
  expect(res.status).toBe(403)
  expect(updateSettingsMock).not.toHaveBeenCalled()
})

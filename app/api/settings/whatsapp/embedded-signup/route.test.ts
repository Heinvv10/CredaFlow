/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"

const requireApiRoleMock = vi.fn()
const updateSettingsMock = vi.fn()
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1" }) }))
vi.mock("@/lib/inbox/settings", () => ({ updateCommsSettings: (t: unknown, p: unknown) => updateSettingsMock(t, p) }))
vi.mock("@/lib/whatsapp/embedded-signup", () => ({
  exchangeCodeForToken: vi.fn(async () => "EAAB-biz"),
  subscribeAppToWaba: vi.fn(async () => {}),
}))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))

import { PATCH } from "./route"
import { subscribeAppToWaba } from "@/lib/whatsapp/embedded-signup"
import { logAudit } from "@/lib/audit"

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c" } })
  updateSettingsMock.mockResolvedValue({ id: "cs1", tenantId: "t1" })
})

it("exchanges the code, subscribes, and stores creds with waProvider=WA_CLOUD", async () => {
  const res = await PATCH(new NextRequest("http://x/api/settings/whatsapp/embedded-signup", {
    method: "PATCH", body: JSON.stringify({ code: "AUTHCODE", wabaId: "WABA1", phoneNumberId: "PN1" }),
  }))
  expect(res.status).toBe(200)
  expect(subscribeAppToWaba).toHaveBeenCalledWith("WABA1", "EAAB-biz")
  expect(updateSettingsMock).toHaveBeenCalledWith("t1", expect.objectContaining({
    waProvider: "WA_CLOUD", wabaId: "WABA1", wabaPhoneNumberId: "PN1", wabaAccessToken: "EAAB-biz",
  }))
})

it("audits COMMS_SETTINGS_UPDATED against the updated row's id", async () => {
  await PATCH(new NextRequest("http://x/api/settings/whatsapp/embedded-signup", {
    method: "PATCH", body: JSON.stringify({ code: "AUTHCODE", wabaId: "WABA1", phoneNumberId: "PN1" }),
  }))
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
    action: "COMMS_SETTINGS_UPDATED", entity: "CommsSettings", entityId: "cs1",
  }))
})

it("never puts the business token in the audit row or the response", async () => {
  const res = await PATCH(new NextRequest("http://x/api/settings/whatsapp/embedded-signup", {
    method: "PATCH", body: JSON.stringify({ code: "AUTHCODE", wabaId: "WABA1", phoneNumberId: "PN1" }),
  }))
  expect(JSON.stringify(await res.json())).not.toContain("EAAB-biz")
  expect(JSON.stringify(vi.mocked(logAudit).mock.calls)).not.toContain("EAAB-biz")
})

it("is ADMIN-guarded", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
  const res = await PATCH(new NextRequest("http://x/api/settings/whatsapp/embedded-signup", {
    method: "PATCH", body: JSON.stringify({ code: "x", wabaId: "y", phoneNumberId: "z" }),
  }))
  expect(res.status).toBe(403)
  expect(updateSettingsMock).not.toHaveBeenCalled()
})

it("returns 409 when the phone_number_id is already connected to another tenant (P2002)", async () => {
  updateSettingsMock.mockRejectedValue(
    new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "5.x",
    }),
  )
  const res = await PATCH(new NextRequest("http://x/api/settings/whatsapp/embedded-signup", {
    method: "PATCH", body: JSON.stringify({ code: "AUTHCODE", wabaId: "WABA1", phoneNumberId: "PN1" }),
  }))
  expect(res.status).toBe(409)
  const body = await res.json()
  expect(body).toEqual({ error: "This WhatsApp number is already connected to another tenant" })
})

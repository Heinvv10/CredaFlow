/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const withTenantContextMock = vi.fn()
const clientFindFirstMock = vi.fn()
const getCommsSettingsMock = vi.fn()
const getChannelAvailabilityMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string; name: string }) => Promise<unknown>) =>
    withTenantContextMock(req, cb),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: {
      findFirst: (a: unknown) => clientFindFirstMock(a),
    },
  },
}))
vi.mock("@/lib/inbox/settings", () => ({
  getCommsSettings: (a: unknown) => getCommsSettingsMock(a),
}))
vi.mock("@/lib/messaging/channel-availability", () => ({
  getChannelAvailability: (a: unknown) => getChannelAvailabilityMock(a),
}))

import { GET } from "./route"

const ctx = { params: Promise.resolve({ id: "c1" }) }
function req() {
  return new NextRequest("http://x/api/clients/c1/channel-availability")
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "READONLY" } })
  withTenantContextMock.mockImplementation((_req: unknown, cb: (t: { id: string; name: string }) => Promise<unknown>) =>
    cb({ id: "t1", name: "Acme Lending" }))
})

it("401 when the guard denies", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
  const res = await GET(req(), ctx)
  expect(res.status).toBe(401)
  expect(clientFindFirstMock).not.toHaveBeenCalled()
})

it("400 when the client has no contact", async () => {
  clientFindFirstMock.mockResolvedValue({ id: "c1", contact: null })
  const res = await GET(req(), ctx)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "client has no contact" })
  expect(getCommsSettingsMock).not.toHaveBeenCalled()
})

it("400 when the client does not exist", async () => {
  clientFindFirstMock.mockResolvedValue(null)
  const res = await GET(req(), ctx)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "client has no contact" })
})

it("200 returns the 3-channel map WITHOUT toValue", async () => {
  const contact = {
    id: "ct1",
    primaryPhone: "+27821234567",
    primaryWaJid: "27821234567@s.whatsapp.net",
    primaryEmail: "a@b.c",
    blockedAt: null,
    status: "ACTIVE",
  }
  clientFindFirstMock.mockResolvedValue({ id: "c1", contact })
  getCommsSettingsMock.mockResolvedValue({ whatsappEnabled: true })
  getChannelAvailabilityMock.mockResolvedValue({
    EMAIL: { enabled: true, toValue: "a@b.c" },
    WHATSAPP: { enabled: true, toValue: "27821234567@s.whatsapp.net" },
    SMS: { enabled: false, toValue: "+27821234567", reason: "SMS not enabled" },
  })

  const res = await GET(req(), ctx)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    EMAIL: { enabled: true },
    WHATSAPP: { enabled: true },
    SMS: { enabled: false, reason: "SMS not enabled" },
  })
  expect(clientFindFirstMock).toHaveBeenCalledWith({
    where: { id: "c1", tenantId: "t1" },
    include: { contact: true },
  })
  expect(getCommsSettingsMock).toHaveBeenCalledWith("t1")
  expect(getChannelAvailabilityMock).toHaveBeenCalledWith({
    tenantId: "t1",
    contact,
    whatsappEnabled: true,
  })
})

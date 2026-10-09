/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const verifyCronSecretMock = vi.fn()
const findManyMock = vi.fn()
const pollTenantInboxMock = vi.fn()

vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: (...a: any[]) => verifyCronSecretMock(...a) }))
vi.mock("@/lib/tenant-scope", () => ({ withoutTenantScope: (fn: () => Promise<unknown>) => fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { emailConfig: { findMany: (...a: any[]) => findManyMock(...a) } } }))
vi.mock("@/lib/email/inbound-poll", () => ({ pollTenantInbox: (...a: any[]) => pollTenantInboxMock(...a) }))

import { GET } from "./route"

const req = () => new NextRequest("http://localhost/api/cron/email-poll")

beforeEach(() => {
  vi.clearAllMocks()
  verifyCronSecretMock.mockReturnValue(null)
})

describe("GET /api/cron/email-poll", () => {
  it("returns 200 ok:true when every tenant polls cleanly", async () => {
    findManyMock.mockResolvedValue([{ tenantId: "t1", active: true }])
    pollTenantInboxMock.mockResolvedValue({ ok: true, checked: 5, matched: 1 })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("returns a NON-2XX with ok:false when ANY tenant poll fails", async () => {
    // The systemd wrapper is `curl -fsS`: it only fails the unit on HTTP >= 400
    // and never parses the body. A 200 with ok:false kept 1,966 consecutive
    // IMAP failures invisible. This assertion is the regression fence.
    findManyMock.mockResolvedValue([
      { tenantId: "t1", active: true },
      { tenantId: "t2", active: true },
    ])
    pollTenantInboxMock
      .mockResolvedValueOnce({ ok: true, checked: 5, matched: 1 })
      .mockResolvedValueOnce({ ok: false, message: "wrong version number" })
    const res = await GET(req())
    expect(res.status).toBeGreaterThanOrEqual(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
    // Per-tenant detail stays in the body so an operator can see WHICH tenant.
    expect(body.perTenant).toContainEqual(
      expect.objectContaining({ tenantId: "t2", ok: false, message: "wrong version number" }),
    )
  })

  it("returns 200 when there are no configured tenants (vacuously ok)", async () => {
    findManyMock.mockResolvedValue([])
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("refuses an unauthenticated call", async () => {
    verifyCronSecretMock.mockReturnValue(new Response("no", { status: 401 }))
    expect((await GET(req())).status).toBe(401)
    expect(findManyMock).not.toHaveBeenCalled()
  })
})

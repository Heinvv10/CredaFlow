import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"

const requireApiRoleMock = vi.fn()
const updateLenderIdentityMock = vi.fn()
const tenantConfigFindUniqueMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (...args: unknown[]) => requireApiRoleMock(...args),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: (args: unknown) => tenantConfigFindUniqueMock(args) },
  },
}))
vi.mock("@/lib/config/identity-write", () => ({
  updateLenderIdentity: (...args: unknown[]) => updateLenderIdentityMock(...args),
}))
vi.mock("@/lib/rate-limit", () => ({ callerIp: () => "127.0.0.1" }))

import { GET, PUT } from "./route"

const URL = "https://app.example.test/api/settings/identity"

function putReq(body: string) {
  return new NextRequest(URL, { method: "PUT", headers: { "content-type": "application/json" }, body })
}

describe("/api/settings/identity", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "admin-1", email: "admin@acme-lending.example", totpVerified: true } })
    tenantConfigFindUniqueMock.mockResolvedValue(VALID_LENDER_COLUMNS)
  })

  // A password-only session (no TOTP checked at sign-in) cannot write, even if
  // the account enrolled TOTP after signing in.
  it.each([false, undefined])("refuses a write from a session whose sign-in did not verify TOTP (%j), and writes nothing", async (totpVerified) => {
    requireApiRoleMock.mockResolvedValue({ user: { id: "admin-1", email: "admin@acme-lending.example", totpVerified } })
    const res = await PUT(putReq(JSON.stringify(VALID_LENDER_COLUMNS)))
    expect(res.status).toBe(403)
    expect(updateLenderIdentityMock).not.toHaveBeenCalled()
  })

  it("requires ADMIN on GET and PUT", async () => {
    updateLenderIdentityMock.mockResolvedValue({ ok: true, changed: false, identity: VALID_LENDER_COLUMNS })
    await GET(new NextRequest(URL))
    await PUT(putReq(JSON.stringify(VALID_LENDER_COLUMNS)))
    expect(requireApiRoleMock.mock.calls).toEqual([["ADMIN"], ["ADMIN"]])
  })

  it("refuses when the role guard rejects, and writes nothing", async () => {
    requireApiRoleMock.mockResolvedValue({ error: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }) })
    expect((await PUT(putReq(JSON.stringify(VALID_LENDER_COLUMNS)))).status).toBe(403)
    expect((await GET(new NextRequest(URL))).status).toBe(403)
    expect(updateLenderIdentityMock).not.toHaveBeenCalled()
  })

  it("returns the stored columns on GET, with nulls for an unconfigured tenant", async () => {
    tenantConfigFindUniqueMock.mockResolvedValue(null)
    const res = await GET(new NextRequest(URL))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.identity.ncrNumber).toBeNull()
    expect(body.identity.legalName).toBeNull()
  })

  it("rejects malformed JSON without calling the writer", async () => {
    expect((await PUT(putReq("{"))).status).toBe(400)
    expect(updateLenderIdentityMock).not.toHaveBeenCalled()
  })

  it("passes tenant, actor and caller IP to the single write path", async () => {
    updateLenderIdentityMock.mockResolvedValue({ ok: true, changed: true, identity: VALID_LENDER_COLUMNS })
    const res = await PUT(putReq(JSON.stringify(VALID_LENDER_COLUMNS)))
    expect(res.status).toBe(200)
    expect(updateLenderIdentityMock).toHaveBeenCalledWith(expect.anything(), {
      tenantId: "tenant-1",
      actor: { id: "admin-1", email: "admin@acme-lending.example" },
      input: VALID_LENDER_COLUMNS,
      ipAddress: "127.0.0.1",
    })
  })

  it("returns 400 with per-field errors when validation fails", async () => {
    updateLenderIdentityMock.mockResolvedValue({ ok: false, errors: { ncrNumber: "bad" } })
    const res = await PUT(putReq(JSON.stringify({ ...VALID_LENDER_COLUMNS, ncrNumber: "x" })))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Invalid lender identity.", errors: { ncrNumber: "bad" } })
  })
})

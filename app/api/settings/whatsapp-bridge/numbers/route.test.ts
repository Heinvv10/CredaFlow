import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: vi.fn() }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: vi.fn() }))
// importOriginal, not a bare factory: the route reads the real AuditAction
// constants, and a factory that returns only logAudit makes them undefined.
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>()
  return { ...actual, logAudit: vi.fn() }
})
// importOriginal so the real WaBridgeError class survives the mock — a bare
// factory leaves it undefined and the test fails on construction, not on the
// behaviour under test.
vi.mock("@/lib/whatsapp-bridge-admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/whatsapp-bridge-admin")>()
  return { ...actual, listWaBridgeNumbers: vi.fn(), addWaBridgeNumber: vi.fn() }
})

import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import { listWaBridgeNumbers, addWaBridgeNumber, WaBridgeError } from "@/lib/whatsapp-bridge-admin"
import { GET, POST } from "./route"

describe("GET/POST /api/settings/whatsapp-bridge/numbers", () => {
  beforeEach(() => vi.clearAllMocks())

  it("GET returns 403 when the guard rejects the caller", async () => {
    vi.mocked(requireApiRole).mockResolvedValue({ error: new Response(null, { status: 403 }) } as never)
    const res = await GET(new NextRequest("http://x/api/settings/whatsapp-bridge/numbers"))
    expect(res.status).toBe(403)
  })

  it("GET returns the bridge's number list", async () => {
    vi.mocked(requireApiRole).mockResolvedValue({ error: null } as never)
    vi.mocked(listWaBridgeNumbers).mockResolvedValue([{ slotId: "a", status: "CONNECTED" }] as never)
    const res = await GET(new NextRequest("http://x/api/settings/whatsapp-bridge/numbers"))
    const body = await res.json()
    expect(body.numbers).toHaveLength(1)
  })

  it("POST adds a number and writes an audit log entry", async () => {
    vi.mocked(requireApiRole).mockResolvedValue({ error: null, user: { id: "u1", email: "a@x.com" } } as never)
    vi.mocked(addWaBridgeNumber).mockResolvedValue({ slotId: "s1", pairingCode: "ABCD1234", expiresAt: "x" } as never)
    vi.mocked(withTenantContext).mockImplementation((_req, fn) => fn({ id: "tenant-1" } as never))

    const req = new NextRequest("http://x/api/settings/whatsapp-bridge/numbers", { method: "POST", body: JSON.stringify({ number: "27821234567" }) })
    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "WA_BRIDGE_NUMBER_ADDED", tenantId: "tenant-1" }))
  })

  it("POST returns 403 when the guard rejects the caller", async () => {
    vi.mocked(requireApiRole).mockResolvedValue({ error: new Response(null, { status: 403 }) } as never)
    const req = new NextRequest("http://x/api/settings/whatsapp-bridge/numbers", { method: "POST", body: JSON.stringify({ number: "27821234567" }) })
    const res = await POST(req)
    expect(res.status).toBe(403)
    expect(addWaBridgeNumber).not.toHaveBeenCalled()
  })

  it("POST rejects a missing number", async () => {
    vi.mocked(requireApiRole).mockResolvedValue({ error: null } as never)
    const req = new NextRequest("http://x/api/settings/whatsapp-bridge/numbers", { method: "POST", body: JSON.stringify({}) })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  // The client aborts POST /numbers at 40s. The bridge can have created AND
  // paired the slot before the response was lost — a live paired number with
  // no audit row and no pairing code ever shown to the admin. The slotId the
  // bridge minted never reaches us, so the number is the only identifier.
  it("writes an audit row when adding a number FAILS, keyed on the number", async () => {
    vi.mocked(requireApiRole).mockResolvedValue({ error: null, user: { id: "u1", email: "a@x.com" } } as never)
    vi.mocked(withTenantContext).mockImplementation((_req, fn) => fn({ id: "tenant-1" } as never))
    vi.mocked(addWaBridgeNumber).mockRejectedValue(new Error("The operation was aborted"))
    const req = new NextRequest("http://x", { method: "POST", body: JSON.stringify({ number: "27820000001" }) })
    const res = await POST(req)
    expect(res.status).toBe(502)
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WA_BRIDGE_NUMBER_ADDED",
        newValue: expect.objectContaining({ outcome: "UNCERTAIN", number: "27820000001" }),
      }),
    )
  })

  // A guard rejection is CERTAIN — the bridge refused before attempting
  // anything — so it must not be filed as "outcome unknown". False doubt in a
  // regulated audit trail is its own defect.
  it("audits a duplicate-number refusal as REJECTED, not UNCERTAIN", async () => {
    vi.mocked(requireApiRole).mockResolvedValue({ error: null, user: { id: "u1", email: "a@x.com" } } as never)
    vi.mocked(withTenantContext).mockImplementation((_req, fn) => fn({ id: "tenant-1" } as never))
    const conflict = new WaBridgeError("27820000202 is already in this bridge's pool.", 409)
    vi.mocked(addWaBridgeNumber).mockRejectedValue(conflict)

    const req = new NextRequest("http://x", { method: "POST", body: JSON.stringify({ number: "27820000202" }) })
    await POST(req)

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WA_BRIDGE_NUMBER_ADDED",
        newValue: expect.objectContaining({ outcome: "REJECTED" }),
      }),
    )
  })
})

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: vi.fn() }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: vi.fn() }))
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>()
  return { ...actual, logAudit: vi.fn() }
})
vi.mock("@/lib/whatsapp-bridge-admin", () => ({ setWaBridgeNumberPriority: vi.fn(), retireWaBridgeNumber: vi.fn() }))

import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import { setWaBridgeNumberPriority, retireWaBridgeNumber } from "@/lib/whatsapp-bridge-admin"
import { PATCH, DELETE } from "./route"

const ctx = { params: Promise.resolve({ slotId: "slot-b" }) }

describe("PATCH/DELETE /api/settings/whatsapp-bridge/numbers/[slotId]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireApiRole).mockResolvedValue({ error: null, user: { id: "u1", email: "a@x.com" } } as never)
    vi.mocked(withTenantContext).mockImplementation((_req, fn) => fn({ id: "tenant-1" } as never))
    vi.mocked(retireWaBridgeNumber).mockResolvedValue({ authDirRemoved: true } as never)
  })

  it("PATCH returns 403 when the guard rejects the caller", async () => {
    vi.mocked(requireApiRole).mockResolvedValue({ error: new Response(null, { status: 403 }) } as never)
    const req = new NextRequest("http://x", { method: "PATCH", body: JSON.stringify({ priority: 2 }) })
    const res = await PATCH(req, ctx)
    expect(res.status).toBe(403)
    expect(setWaBridgeNumberPriority).not.toHaveBeenCalled()
  })

  it("DELETE returns 403 when the guard rejects the caller", async () => {
    vi.mocked(requireApiRole).mockResolvedValue({ error: new Response(null, { status: 403 }) } as never)
    const req = new NextRequest("http://x", { method: "DELETE" })
    const res = await DELETE(req, ctx)
    expect(res.status).toBe(403)
    expect(retireWaBridgeNumber).not.toHaveBeenCalled()
  })

  it("PATCH rejects a non-numeric priority", async () => {
    const req = new NextRequest("http://x", { method: "PATCH", body: JSON.stringify({ priority: "high" }) })
    const res = await PATCH(req, ctx)
    expect(res.status).toBe(400)
  })

  it("PATCH sets priority via the bridge client", async () => {
    const req = new NextRequest("http://x", { method: "PATCH", body: JSON.stringify({ priority: 2 }) })
    const res = await PATCH(req, ctx)
    expect(res.status).toBe(200)
    expect(setWaBridgeNumberPriority).toHaveBeenCalledWith("slot-b", 2)
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "WA_BRIDGE_NUMBER_REORDERED", tenantId: "tenant-1", entityId: "slot-b" }),
    )
  })

  it("DELETE retires the number", async () => {
    const req = new NextRequest("http://x", { method: "DELETE" })
    const res = await DELETE(req, ctx)
    expect(res.status).toBe(200)
    expect(retireWaBridgeNumber).toHaveBeenCalledWith("slot-b")
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "WA_BRIDGE_NUMBER_RETIRED", tenantId: "tenant-1", entityId: "slot-b" }),
    )
  })

  // COMPLIANCE (adversarial review): the bridge's mutations are non-atomic, so
  // a thrown error does NOT mean nothing happened. retireSlot logs the number
  // out of WhatsApp, closes the socket and drops the slot from the pool BEFORE
  // its final step; an HTTP timeout can also land after the bridge committed.
  // Auditing only on success left a number logged out of WhatsApp with an
  // empty AuditLog and a 502 telling the admin it had failed.

  it("DELETE writes an audit row when the retire FAILS, marked UNCERTAIN", async () => {
    vi.mocked(retireWaBridgeNumber).mockRejectedValue(new Error("bridge retire failed: 500"))
    const res = await DELETE(new NextRequest("http://x", { method: "DELETE" }), ctx)
    expect(res.status).toBe(502)
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WA_BRIDGE_NUMBER_RETIRED",
        tenantId: "tenant-1",
        entityId: "slot-b",
        newValue: expect.objectContaining({ outcome: "UNCERTAIN" }),
      }),
    )
  })

  it("PATCH writes an audit row when the priority change FAILS", async () => {
    vi.mocked(setWaBridgeNumberPriority).mockRejectedValue(new Error("bridge unreachable"))
    const req = new NextRequest("http://x", { method: "PATCH", body: JSON.stringify({ priority: 2 }) })
    const res = await PATCH(req, ctx)
    expect(res.status).toBe(502)
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WA_BRIDGE_NUMBER_REORDERED",
        newValue: expect.objectContaining({ outcome: "UNCERTAIN", priority: 2 }),
      }),
    )
  })

  it("DELETE surfaces a failed auth-dir cleanup without calling the retire a failure", async () => {
    vi.mocked(retireWaBridgeNumber).mockResolvedValue({ authDirRemoved: false } as never)
    const res = await DELETE(new NextRequest("http://x", { method: "DELETE" }), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, authDirRemoved: false })
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ newValue: expect.objectContaining({ authDirRemoved: false }) }),
    )
  })
})

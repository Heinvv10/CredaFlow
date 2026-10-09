import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: vi.fn() }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: vi.fn() }))
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>()
  return { ...actual, logAudit: vi.fn() }
})
vi.mock("@/lib/whatsapp-bridge-admin", () => ({ promoteWaBridgeNumber: vi.fn() }))

import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import { promoteWaBridgeNumber } from "@/lib/whatsapp-bridge-admin"
import { POST } from "./route"

describe("POST /api/settings/whatsapp-bridge/numbers/[slotId]/promote", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireApiRole).mockResolvedValue({ error: null, user: { id: "u1", email: "a@x.com" } } as never)
    vi.mocked(withTenantContext).mockImplementation((_req, fn) => fn({ id: "tenant-1" } as never))
  })

  it("promotes the given slot", async () => {
    const req = new NextRequest("http://x", { method: "POST" })
    const res = await POST(req, { params: Promise.resolve({ slotId: "slot-b" }) })
    expect(res.status).toBe(200)
    expect(promoteWaBridgeNumber).toHaveBeenCalledWith("slot-b")
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "WA_BRIDGE_NUMBER_PROMOTED", tenantId: "tenant-1", entityId: "slot-b" }),
    )
  })

  it("returns 403 when the guard rejects the caller", async () => {
    vi.mocked(requireApiRole).mockResolvedValue({ error: new Response(null, { status: 403 }) } as never)
    const req = new NextRequest("http://x", { method: "POST" })
    const res = await POST(req, { params: Promise.resolve({ slotId: "slot-b" }) })
    expect(res.status).toBe(403)
    expect(promoteWaBridgeNumber).not.toHaveBeenCalled()
  })
})

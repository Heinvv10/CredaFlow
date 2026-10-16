import { beforeEach, describe, expect, it, vi } from "vitest"

const { getDocumentCaller, captureSelfie, auditDocumentAccessRefusal } = vi.hoisted(() => ({
  getDocumentCaller: vi.fn(),
  captureSelfie: vi.fn(),
  auditDocumentAccessRefusal: vi.fn(),
}))

vi.mock("@/lib/document-auth", () => ({ getDocumentCaller }))
vi.mock("@/lib/kyc/selfie-capture.server", () => ({ captureSelfie }))
vi.mock("@/lib/audit-refusals", () => ({ auditDocumentAccessRefusal, auditRefusal: vi.fn() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "tenant-1" }),
}))

import { POST } from "./route"

function request() {
  const form = new FormData()
  form.set("image", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "selfie.jpg", { type: "image/jpeg" }))
  form.set("clientId", "client-1")
  return new Request("https://staging.acme-lending.example/api/documents/selfie", { method: "POST", body: form })
}

beforeEach(() => {
  vi.clearAllMocks()
  captureSelfie.mockResolvedValue({ ok: true, document: { id: "selfie-1" } })
})

describe("POST /api/documents/selfie — a read-only role", () => {
  it("refuses READONLY with 403 before reading the body, starts no capture, and audits it", async () => {
    getDocumentCaller.mockResolvedValue({ type: "staff", userId: "viewer-1", role: "READONLY", tenantId: "tenant-1" })
    const req = request()

    const res = await POST(req as never)

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Your role can view documents but not change them." })
    expect(req.bodyUsed).toBe(false)
    expect(captureSelfie).not.toHaveBeenCalled()
    expect(auditDocumentAccessRefusal).toHaveBeenCalledWith(expect.objectContaining({
      documentId: "selfie",
      reason: "document_write_read_only_role",
      status: 403,
      tenantId: "tenant-1",
      actorUserId: "viewer-1",
      detail: { action: "selfie", role: "READONLY" },
    }))
  })

  it.each(["COLLECTIONS_OFFICER", "INSURANCE_OFFICER", "CREDIT_OFFICER"])("still lets %s capture", async (role) => {
    getDocumentCaller.mockResolvedValue({ type: "staff", userId: "staff-1", role, tenantId: "tenant-1" })

    const res = await POST(request() as never)

    expect(res.status).toBe(201)
    expect(captureSelfie).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "client-1",
      uploader: { type: "staff", userId: "staff-1" },
    }))
    expect(auditDocumentAccessRefusal).not.toHaveBeenCalled()
  })

  it("still lets a portal client capture their own selfie", async () => {
    getDocumentCaller.mockResolvedValue({ type: "client", clientId: "client-9", email: "c@example.test" })

    const res = await POST(request() as never)

    expect(res.status).toBe(201)
    expect(captureSelfie).toHaveBeenCalledWith(expect.objectContaining({ clientId: "client-9" }))
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/**
 * Regression cover for the two behaviours the pipeline extraction changed and
 * that blind review caught. Deliberately a SEPARATE file: route.test.ts is the
 * evidence that the extraction preserved behaviour, and it only carries that
 * weight while it stays byte-for-byte unchanged from before the refactor.
 *
 * Neither path had a test before — the original suite has no 4xx assertions at
 * all — which is exactly why both divergences survived a green suite.
 */

const getDocumentCallerMock = vi.fn()

vi.mock("@/lib/document-auth", () => ({
  getDocumentCaller: () => getDocumentCallerMock(),
  MAGIC_BYTE_PREFIX: 12,
  matchesMagic: () => true,
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    _req: unknown,
    callback: (tenant: { id: string }) => Promise<unknown>,
  ) => callback({ id: "tenant-1" }),
}))
// Reached only if a test gets further than the input validation it asserts on;
// a call here would itself be the failure.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    clientDocument: { findFirst: vi.fn().mockResolvedValue(null) },
    client: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
  },
}))
vi.mock("@/lib/storage", () => ({
  saveFile: vi.fn(),
  deleteFile: vi.fn(),
  readFile: vi.fn(),
}))
vi.mock("@/lib/vlm-extract", () => ({ extractDocumentData: vi.fn() }))

import { POST } from "./route"

const STAFF = { type: "staff", userId: "user-1", tenantId: "tenant-1", role: "CREDIT_OFFICER" }

function jpeg(): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "s.jpg", { type: "image/jpeg" })
}

function multipart(fd: FormData): NextRequest {
  return new NextRequest("http://x/api/documents/selfie", { method: "POST", body: fd })
}

beforeEach(() => {
  vi.clearAllMocks()
  getDocumentCallerMock.mockResolvedValue(STAFF)
})

describe("POST /api/documents/selfie — extraction regressions", () => {
  it("returns the structured 500 error when the multipart body cannot be parsed", async () => {
    // The original wrapped formData parsing in a try/catch. Losing it turned a
    // truncated upload — routine on a flaky mobile connection — into an
    // uncaught throw instead of the JSON error every caller expects.
    const broken = new NextRequest("http://x/api/documents/selfie", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=----nope" },
      body: "not actually multipart",
    })

    const res = await POST(broken)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Failed to upload selfie" })
  })

  it("reports the missing image before the missing clientId, as the original did", async () => {
    // Order regression: hoisting the clientId check into the route made a
    // staff request missing BOTH report the wrong one first.
    const res = await POST(multipart(new FormData()))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "image is required" })
  })

  it("still refuses a staff upload that names no client", async () => {
    const fd = new FormData()
    fd.append("image", jpeg())

    const res = await POST(multipart(fd))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "clientId is required for staff uploads" })
  })

  it("does not require a clientId from a portal client, who uploads only for themselves", async () => {
    getDocumentCallerMock.mockResolvedValue({
      type: "client",
      clientId: "client-1",
      email: "c@example.test",
    })
    const fd = new FormData()
    fd.append("image", jpeg())

    const res = await POST(multipart(fd))

    // Past validation and into the pipeline, which refuses for want of an ID
    // document — proving the clientId came from the session, not the body.
    expect(res.status).toBe(422)
  })
})

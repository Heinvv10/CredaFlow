import { afterEach, describe, it, expect, vi, beforeEach } from "vitest"

// document-auth.ts pulls in auth/prisma/tenant at module load; stub them so the
// pure magic-byte helper can be imported in isolation.
const authMock = vi.fn()
const getDefaultTenantIdMock = vi.fn()
const userFindUniqueMock = vi.fn()
const clientFindFirstMock = vi.fn()
const createManyMock = vi.fn()

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: (a: unknown) => userFindUniqueMock(a) },
    client: { findFirst: (a: unknown) => clientFindFirstMock(a) },
    documentAccessLog: { createMany: (a: unknown) => createManyMock(a) },
  },
}))
vi.mock("@/lib/tenant", () => ({ getDefaultTenantId: () => getDefaultTenantIdMock() }))

import { logDocumentAccess, matchesMagic, MAGIC_BYTE_PREFIX, getDocumentCaller, logDocumentContentAccess } from "./document-auth"

afterEach(() => {
  vi.unstubAllEnvs()
})

// Pad an arbitrary byte prefix out to the number of bytes callers actually read.
function head(bytes: number[]): Uint8Array {
  const arr = new Uint8Array(MAGIC_BYTE_PREFIX)
  arr.set(bytes.slice(0, MAGIC_BYTE_PREFIX))
  return arr
}

describe("matchesMagic", () => {
  it("accepts a real PDF header (%PDF)", () => {
    expect(matchesMagic(head([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]), "application/pdf")).toBe(true)
  })

  it("accepts a real PNG header", () => {
    expect(matchesMagic(head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png")).toBe(true)
  })

  it("accepts a real JPEG header", () => {
    expect(matchesMagic(head([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg")).toBe(true)
  })

  it("accepts a real WebP header (RIFF....WEBP)", () => {
    expect(
      matchesMagic(head([0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]), "image/webp"),
    ).toBe(true)
  })

  it("rejects a RIFF container that is not WebP (e.g. WAV) — offset-8 guard", () => {
    // First segment (RIFF) matches; "WAVE" at offset 8 does not.
    expect(
      matchesMagic(head([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]), "image/webp"),
    ).toBe(false)
  })

  it("rejects a text blob declared as PNG (spoofed Content-Type)", () => {
    expect(matchesMagic(head([0x68, 0x65, 0x6c, 0x6c, 0x6f]), "image/png")).toBe(false)
  })

  it("rejects an unknown / unsupported MIME (fails closed)", () => {
    expect(matchesMagic(head([0x25, 0x50, 0x44, 0x46]), "application/x-msdownload")).toBe(false)
  })

  it("fails closed on a header too short to cover the signature (no throw)", () => {
    // Only 4 bytes: the WebP RIFF segment matches but the offset-8 WEBP segment
    // reads past the end (undefined !== 0x57), so it fails to match rather than
    // throwing — the real risk for a tiny uploaded file.
    expect(matchesMagic(new Uint8Array([0x52, 0x49, 0x46, 0x46]), "image/webp")).toBe(false)
  })
})

describe("getDocumentCaller — tenant", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDefaultTenantIdMock.mockResolvedValue("default-tenant")
  })

  it("looks a portal client up in the session's own tenant, not the default", async () => {
    authMock.mockResolvedValue({ user: { id: "c1", email: "client@example.test", role: "CLIENT", tenantId: "tenant-b" } })
    clientFindFirstMock.mockResolvedValue({ id: "c1", email: "client@example.test" })

    const caller = await getDocumentCaller()

    expect(caller).toEqual({ type: "client", clientId: "c1", email: "client@example.test" })
    expect(clientFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "client@example.test", tenantId: "tenant-b" } }),
    )
    expect(getDefaultTenantIdMock).not.toHaveBeenCalled()
  })

  it("does not resolve a portal caller whose session carries no tenant", async () => {
    authMock.mockResolvedValue({ user: { id: "c1", email: "client@example.test", role: "CLIENT" } })

    expect(await getDocumentCaller()).toBeNull()
    expect(clientFindFirstMock).not.toHaveBeenCalled()
  })

  it("does not resolve a same-email client that only exists in the default tenant", async () => {
    authMock.mockResolvedValue({ user: { id: "c1", email: "client@example.test", role: "CLIENT", tenantId: "tenant-b" } })
    clientFindFirstMock.mockResolvedValue(null)

    expect(await getDocumentCaller()).toBeNull()
  })

  it("returns staff with their own persisted tenant and never consults the default", async () => {
    authMock.mockResolvedValue({ user: { id: "u1", email: "s@acme-lending.example", role: "LOAN_ADMIN", tenantId: "tenant-b" } })
    userFindUniqueMock.mockResolvedValue({ id: "u1", role: "LOAN_ADMIN", tenantId: "tenant-b" })

    expect(await getDocumentCaller()).toEqual({ type: "staff", userId: "u1", role: "LOAN_ADMIN", tenantId: "tenant-b" })
    expect(getDefaultTenantIdMock).not.toHaveBeenCalled()
  })

  it("resolves an ADMIN session as staff, not as a missing portal client", async () => {
    authMock.mockResolvedValue({ user: { id: "u2", email: "a@acme-lending.example", role: "ADMIN", tenantId: "tenant-b" } })
    userFindUniqueMock.mockResolvedValue({ id: "u2", role: "ADMIN", tenantId: "tenant-b" })

    expect(await getDocumentCaller()).toEqual({ type: "staff", userId: "u2", role: "ADMIN", tenantId: "tenant-b" })
    expect(clientFindFirstMock).not.toHaveBeenCalled()
  })
})

describe("logDocumentContentAccess", () => {
  it("writes one staff access row per distinct document, and nothing for none", async () => {
    const createMany = createManyMock
    vi.stubEnv("TRUSTED_PROXY", "1")
    const req = new Request("https://acme.example/x", {
      headers: { "x-forwarded-for": "attacker, 203.0.113.9", "user-agent": "test-agent" },
    })
    await logDocumentContentAccess({ documentIds: [], staffUserId: "u1", action: "credit_check_evidence", req })
    expect(createMany).not.toHaveBeenCalled()
    await logDocumentContentAccess({ documentIds: ["d1", "d2", "d1"], staffUserId: "u1", action: "credit_check_evidence", req })
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { documentId: "d1", accessorType: "staff", accessorId: "u1", action: "credit_check_evidence", ipAddress: "203.0.113.9", userAgent: "test-agent" },
        { documentId: "d2", accessorType: "staff", accessorId: "u1", action: "credit_check_evidence", ipAddress: "203.0.113.9", userAgent: "test-agent" },
      ],
    })
  })
})

describe("logDocumentAccess", () => {
  const write = async (headers: Record<string, string>) => {
    const create = vi.fn()
    await logDocumentAccess({ documentAccessLog: { create } } as unknown as Parameters<typeof logDocumentAccess>[0], {
      documentId: "doc-1",
      accessorType: "client",
      accessorId: "client-1",
      action: "view",
      req: new Request("http://localhost/x", { headers }),
    })
    return create.mock.calls[0][0].data as { ipAddress: string | null; userAgent: string | null }
  }

  it("records the address the trusted proxy saw, not the caller-written left of X-Forwarded-For", async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    const data = await write({ "x-forwarded-for": "198.51.100.7, 203.0.113.9", "user-agent": "vitest" })
    expect(data).toMatchObject({ ipAddress: "203.0.113.9", userAgent: "vitest" })
    vi.unstubAllEnvs()
  })

  it("records no IP when no proxy is trusted: the header is the caller's own claim", async () => {
    vi.stubEnv("TRUSTED_PROXY", "0")
    expect((await write({ "x-forwarded-for": "198.51.100.7" })).ipAddress).toBeNull()
    vi.unstubAllEnvs()
  })
})

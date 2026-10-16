// app/api/insurance/disclosures/[token]/route.test.ts
import { afterEach, describe, expect, it, vi } from "vitest"
import { GET } from "./route"
import { NextRequest } from "next/server"
import { signDraftToken } from "@/lib/insurance/disclosure-token"

const { readFile, getTenantFromRequest } = vi.hoisted(() => ({
  readFile: vi.fn(),
  getTenantFromRequest: vi.fn(),
}))

// storagePathAt keeps its real name check (a segment over 255 characters is refused).
vi.mock("@/lib/storage", async (importOriginal) => {
  const { storagePathAt } = await importOriginal<typeof import("@/lib/storage")>()
  return { readFile, storagePathAt: (rel: string) => { storagePathAt(rel); return `/uploads/${rel}` } }
})
vi.mock("@/lib/prisma", () => ({
  prisma: { tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) } },
}))
// featureIms ON — the IMS API gate (requireImsEnabled) must be a no-op
// for every behaviour asserted below. The gate reads the LIVE TenantConfig
// row (uncached, so the kill switch has no fuse), so it is stubbed on the
// prisma mock rather than on getTenantConfig.
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  getTenantFromRequest,
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) =>
    fn({ id: "t1", name: "Test Tenant" }),
}))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn().mockResolvedValue({ user: { id: "u1", email: "officer@example.com" } }),
}))

afterEach(() => { vi.clearAllMocks() })

describe("GET /api/insurance/disclosures/[token]", () => {
  it("returns 200 with application/pdf for a valid token matching the session tenant", async () => {
    process.env.NEXTAUTH_SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef"

    const token = signDraftToken({
      tenantId: "t1",
      clientId: "c1",
      advisorId: "u1",
      type: "FUNERAL_COVER",
      sumAssured: 50000,
      premiumAmount: 420,
      productId: "p1",
    })

    const pdfContent = Buffer.from("%PDF-1.4\nmock")
    readFile.mockResolvedValue(pdfContent)

    const req = new NextRequest(`http://localhost/api/insurance/disclosures/${token}`)
    const res = await GET(req, { params: Promise.resolve({ token }) })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/pdf")
    const buf = Buffer.from(await res.arrayBuffer())
    expect(buf).toEqual(pdfContent)
  })

  it("returns 422 for a tampered token", async () => {
    process.env.NEXTAUTH_SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef"

    const token = signDraftToken({
      tenantId: "t1",
      clientId: "c1",
      advisorId: "u1",
      type: "FUNERAL_COVER",
      sumAssured: 50000,
      premiumAmount: 420,
      productId: "p1",
    })
    const tamperedToken = token + "garbage"

    const req = new NextRequest(`http://localhost/api/insurance/disclosures/${tamperedToken}`)
    const res = await GET(req, { params: Promise.resolve({ token: tamperedToken }) })

    expect(res.status).toBe(422)
  })

  it("returns 403 for a token signed for a different tenant (cross-tenant)", async () => {
    process.env.NEXTAUTH_SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef"

    // Token is signed for "other-tenant", but session tenant is "t1" (see withTenantContext mock)
    const token = signDraftToken({
      tenantId: "other-tenant",
      clientId: "c1",
      advisorId: "u1",
      type: "FUNERAL_COVER",
      sumAssured: 50000,
      premiumAmount: 420,
      productId: "p1",
    })

    const req = new NextRequest(`http://localhost/api/insurance/disclosures/${token}`)
    const res = await GET(req, { params: Promise.resolve({ token }) })

    expect(res.status).toBe(403)
  })
})

// The PDFs are read through lib/storage (encrypted at rest). Only a missing
// file falls through to the next naming scheme; an integrity failure is an error.
describe("GET /api/insurance/disclosures/[token] through encrypted storage", () => {
  const token = () => {
    process.env.NEXTAUTH_SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef"
    return signDraftToken({ tenantId: "t1", clientId: "c1", advisorId: "u1", type: "FUNERAL_COVER", sumAssured: 50000, premiumAmount: 420, productId: "p1" })
  }
  const get = (t: string) => GET(new NextRequest(`http://localhost/api/insurance/disclosures/${t}`), { params: Promise.resolve({ token: t }) })
  const missing = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" })

  it("falls back to the legacy name only when the hashed one is missing, and 404s when neither exists", async () => {
    const t = token()
    readFile.mockRejectedValueOnce(missing()).mockResolvedValueOnce(Buffer.from("%PDF legacy"))
    expect((await get(t)).status).toBe(200)
    expect(readFile.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringMatching(/^\/uploads\/disclosures\/t1\/[0-9a-f]{64}\.pdf$/),
      `/uploads/disclosures/t1/${t}.pdf`,
    ])
    readFile.mockReset().mockRejectedValue(missing())
    expect((await get(t)).status).toBe(404)
  })

  // Blind review of #139 (LOW): a token from real ids is longer than a file
  // name may be, so it never had a legacy file; a missing PDF is a 404, not
  // the "Invalid storage path" 500.
  it("404s a missing disclosure for a token too long to have a legacy name", async () => {
    process.env.NEXTAUTH_SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef"
    const id = "cmgs8x2k10000qz8h3m1n4b7c"
    const long = signDraftToken({ tenantId: "t1", clientId: id, advisorId: id, type: "FUNERAL_COVER", sumAssured: 50000, premiumAmount: 420, productId: id })
    expect(long.length + ".pdf".length).toBeGreaterThan(255)
    readFile.mockReset().mockRejectedValue(missing())
    expect((await get(long)).status).toBe(404)
    expect(readFile).toHaveBeenCalledOnce()
  })

  it("does not skip past a file that fails its integrity check", async () => {
    readFile.mockReset().mockRejectedValueOnce(Object.assign(new Error("encrypted file failed its integrity check"), { name: "StorageCryptoError" }))
    await expect(get(token())).rejects.toThrow(/integrity/)
    expect(readFile).toHaveBeenCalledOnce()
  })
})

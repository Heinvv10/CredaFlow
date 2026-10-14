import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// Portal deal-signer routes. The portal gate (lib/asset-finance/portal-route.ts)
// and the signature validation run for real; the session, the flag row, the
// signer lookup and the signing operation are stubbed. The real-database
// proof (a SURETY-only client, another surety's row) is
// lib/asset-finance/deal-signing.integration.test.ts.
const m = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
  flag: { on: true },
  signerFindFirst: vi.fn(),
  serve: vi.fn(),
  record: vi.fn(),
  auditRefusal: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => m.session.current) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) },
    dealSigner: { findFirst: m.signerFindFirst },
  },
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/audit-refusals", () => ({ auditRefusal: m.auditRefusal }))
vi.mock("@/lib/asset-finance/entity-document-io", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/asset-finance/entity-document-io")>()),
  serveEntityDocument: m.serve,
}))
vi.mock("@/lib/asset-finance/signing-esign", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/asset-finance/signing-esign")>()),
  recordESignature: m.record,
}))

import { GET as document } from "./document/route"
import { POST as sign } from "./sign/route"
import { _resetRateLimitStore } from "@/lib/rate-limit"
import { portalSignerAuthorityWhere } from "@/lib/asset-finance/portal-access"
import { PORTAL_SIGN_RATE_LIMIT } from "@/lib/asset-finance/portal-rate-limits"

const SHA = "b".repeat(64)
const params = { params: Promise.resolve({ signerId: "signer-1" }) }
const get = () => document(new NextRequest("http://localhost/api/portal/asset-finance/deal-signers/signer-1/document"), params)
const post = (body: unknown) =>
  sign(new NextRequest("http://localhost/api/portal/asset-finance/deal-signers/signer-1/sign", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.66, 203.0.113.9" }, body: JSON.stringify(body),
  }), params)
const asClient = () => {
  m.session.current = { user: { id: "client-1", email: "surety@client.test", role: "CLIENT", tenantId: "tenant-1" } }
}
// A minimal valid PNG data URL (8-byte signature + padding past the length floor).
const PNG = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(92, 1)]).toString("base64")}`

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  _resetRateLimitStore()
  m.flag.on = true
  asClient()
  m.signerFindFirst.mockResolvedValue({
    id: "signer-1", document: "SURETYSHIP", documentSha256: SHA, documentStoragePath: "/x.pdf",
    client: { firstName: "TEST", lastName: "Surety" }, deal: { application: { reference: "AF-1" } },
  })
  m.serve.mockResolvedValue(new Response("pdf", { status: 200 }))
  m.record.mockResolvedValue({ kind: "signed", signedAt: new Date("2026-10-13T10:00:00Z") })
})

describe("portal deal-signer routes", () => {
  it("answers 401 to no session and to a staff session", async () => {
    m.session.current = null
    expect((await get()).status).toBe(401)
    m.session.current = { user: { id: "staff-1", email: "s@lender.test", role: "LOAN_ADMIN", tenantId: "tenant-1" } }
    expect((await post({ signature: "TEST Surety", documentSha256: SHA })).status).toBe(401)
    expect(m.record).not.toHaveBeenCalled()
  })

  it("answers 404 with the flag off", async () => {
    m.flag.on = false
    expect((await get()).status).toBe(404)
    expect((await post({ signature: "TEST Surety", documentSha256: SHA })).status).toBe(404)
    expect(m.signerFindFirst).not.toHaveBeenCalled()
    expect(m.record).not.toHaveBeenCalled()
  })

  it("looks the document up by signer id AND the session client; another's row is 404 and never served", async () => {
    m.signerFindFirst.mockResolvedValue(null)
    expect((await get()).status).toBe(404)
    expect(m.signerFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "signer-1", tenantId: "tenant-1", clientId: "client-1" }),
    }))
    expect(m.serve).not.toHaveBeenCalled()
  })

  it("serves the client's own document as a client read", async () => {
    expect((await get()).status).toBe(200)
    expect(m.serve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "signer-1" }), { type: "client", id: "client-1" })
  })

  it.each([
    [{ signature: "TEST Surety" }, 400],
    [{ signature: "TEST Surety", documentSha256: "nope" }, 400],
    [{ signature: "ab", documentSha256: SHA }, 422],
    [{ documentSha256: SHA }, 422],
    [{ signature: "data:image/jpeg;base64,AAAA", documentSha256: SHA }, 422],
    [{ signature: `data:image/png;base64,${"A".repeat(200)}`, documentSha256: SHA }, 422],
    [{ signature: "x".repeat(500_001), documentSha256: SHA }, 413],
  ])("refuses %j with %i before signing", async (body, status) => {
    expect((await post(body)).status).toBe(status)
    expect(m.record).not.toHaveBeenCalled()
  })

  it("signs a typed name or a drawn PNG for the session client, with the IP the trusted proxy saw", async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    expect((await post({ signature: "  TEST Surety  ", documentSha256: SHA })).status).toBe(200)
    expect(m.record).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1", clientId: "client-1", signerId: "signer-1", ip: "203.0.113.9",
      input: { signature: "TEST Surety", documentSha256: SHA },
    }))
    expect((await post({ signature: PNG, documentSha256: SHA })).status).toBe(200)
  })

  it("maps refusals: not found 404; changed or signed 409, audited", async () => {
    m.record.mockResolvedValue({ kind: "not_found" })
    expect((await post({ signature: "TEST Surety", documentSha256: SHA })).status).toBe(404)
    for (const kind of ["stale_view", "document_changed"]) {
      m.record.mockResolvedValue({ kind })
      expect((await post({ signature: "TEST Surety", documentSha256: SHA })).status).toBe(409)
      expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({ reason: kind, entityId: "signer-1" }))
    }
  })
})

describe("portal deal-signer authority and limits", () => {
  const authority = portalSignerAuthorityWhere("tenant-1", "client-1")

  it("reads the document only while the client holds the relationship authorising the row", async () => {
    expect((await get()).status).toBe(200)
    expect(m.signerFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "signer-1", clientId: "client-1", AND: [authority] }),
    }))
    // The relationship ended (or never authorised this row): the query finds nothing.
    m.signerFindFirst.mockResolvedValue(null)
    expect((await get()).status).toBe(404)
    expect(m.serve).toHaveBeenCalledTimes(1)
  })

  it("refuses to sign 404, recording nothing, once the authorising relationship has ended", async () => {
    m.signerFindFirst.mockResolvedValue(null)
    expect((await post({ signature: "TEST Surety", documentSha256: SHA })).status).toBe(404)
    expect(m.signerFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "signer-1", tenantId: "tenant-1", clientId: "client-1", AND: [authority] },
    }))
    expect(m.record).not.toHaveBeenCalled()
  })

  it("answers 429 past the per-client signing limit without recording a signature", async () => {
    for (let i = 0; i < PORTAL_SIGN_RATE_LIMIT.limit; i++) expect((await post({ signature: "TEST Surety", documentSha256: SHA })).status).toBe(200)
    m.record.mockClear()
    const res = await post({ signature: "TEST Surety", documentSha256: SHA })
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBeTruthy()
    expect(m.record).not.toHaveBeenCalled()
  })
})

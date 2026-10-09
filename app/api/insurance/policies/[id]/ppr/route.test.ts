import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  policyFindFirst: vi.fn(),
  policyUpdateMany: vi.fn(),
  policyUpdate: vi.fn(),
  logAudit: vi.fn(),
}))

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: mocks.requireApiRole }))
// featureIms ON — the IMS API gate (requireImsEnabled) must be a no-op
// for every behaviour asserted below. The gate reads the LIVE TenantConfig
// row (uncached, so the kill switch has no fuse), so it is stubbed on the
// prisma mock rather than on getTenantConfig.
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) },
    insurancePolicy: {
      findFirst: mocks.policyFindFirst,
      updateMany: mocks.policyUpdateMany,
      update: mocks.policyUpdate,
    },
  },
}))
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>()
  return { AuditAction: actual.AuditAction, logAudit: mocks.logAudit }
})

import { POST } from "./route"
import type { NextRequest } from "next/server"

function call(body: Record<string, unknown> = {}) {
  const req = {
    json: async () => body,
    nextUrl: new URL("http://localhost/api/insurance/policies/policy-1/ppr"),
  } as unknown as NextRequest
  return POST(req, { params: Promise.resolve({ id: "policy-1" }) })
}

describe("staff PPR issuance route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireApiRole.mockResolvedValue({
      user: { id: "staff-1", email: "officer@acme-lending.example", role: "INSURANCE_OFFICER" },
    })
    mocks.policyFindFirst.mockResolvedValue({
      id: "policy-1",
      pprIssuedAt: null,
      faisDisclosurePdfUrl: "/api/documents/doc-9/view",
    })
    mocks.policyUpdateMany.mockResolvedValue({ count: 1 })
  })

  it("records issuance and audits it", async () => {
    const res = await call()

    expect(res.status).toBe(200)
    expect(mocks.policyUpdateMany).toHaveBeenCalledOnce()
    expect(mocks.logAudit).toHaveBeenCalledOnce()
    expect(mocks.logAudit.mock.calls[0][0]).toMatchObject({
      tenantId: "tenant-1",
      userId: "staff-1",
      action: "INSURANCE_PPR_ISSUED",
      entity: "InsurancePolicy",
      entityId: "policy-1",
    })
  })

  // The core regression: staff must not be able to assert, in the client's
  // name, that the client acknowledged a disclosure. pprAcknowledgedAt feeds
  // the FSCA return, so a staff-writable path is a manufacturable regulatory
  // record. Acknowledgement lives only on the client-authenticated portal route.
  it("ignores any attempt to stamp the client's acknowledgement", async () => {
    await call({
      pprAcknowledgedAt: "2026-03-05T00:00:00.000Z",
      pprAcknowledgedBy: "Totally The Client",
    })

    const written = mocks.policyUpdateMany.mock.calls[0][0].data
    expect(written).not.toHaveProperty("pprAcknowledgedAt")
    expect(written).not.toHaveProperty("pprAcknowledgedBy")
    expect(mocks.policyUpdate).not.toHaveBeenCalled()
  })

  // Previously `pprIssuedAt: new Date()` ran on every POST, so re-issuing
  // overwrote the genuine issuance date with "now".
  it("does not move an already-recorded issuance date", async () => {
    const original = new Date("2026-03-02T00:00:00.000Z")
    mocks.policyFindFirst.mockResolvedValue({
      id: "policy-1",
      pprIssuedAt: original,
      faisDisclosurePdfUrl: "/api/documents/doc-9/view",
    })

    const res = await call()
    const body = (await res.json()) as { pprIssuedAt?: string; alreadyIssued?: boolean }

    expect(body.pprIssuedAt).toBe(original.toISOString())
    expect(body.alreadyIssued).toBe(true)
    expect(mocks.policyUpdateMany).not.toHaveBeenCalled()
    expect(mocks.logAudit).not.toHaveBeenCalled()
  })

  it("sets issuance under a compare-and-set so concurrent calls cannot both win", async () => {
    await call()

    expect(mocks.policyUpdateMany.mock.calls[0][0].where).toMatchObject({
      id: "policy-1",
      tenantId: "tenant-1",
      pprIssuedAt: null,
    })
  })

  it("does not audit a lost issuance race", async () => {
    mocks.policyUpdateMany.mockResolvedValue({ count: 0 })
    mocks.policyFindFirst
      .mockResolvedValueOnce({ id: "policy-1", pprIssuedAt: null, faisDisclosurePdfUrl: "/api/documents/doc-9/view" })
      .mockResolvedValueOnce({ pprIssuedAt: new Date("2026-03-02T00:00:00.000Z") })

    const res = await call()

    expect(res.status).toBe(200)
    expect(mocks.logAudit).not.toHaveBeenCalled()
  })

  // "Issued" must mean a document exists. The disbursement path refuses to
  // stamp this without the artifact because doing so is a false compliance
  // claim; pprIssuedAt gates status=ACTIVE and is the FSCA denominator.
  it("refuses to record issuance when no disclosure document is stored", async () => {
    mocks.policyFindFirst.mockResolvedValue({
      id: "policy-1",
      pprIssuedAt: null,
      faisDisclosurePdfUrl: null,
    })

    const res = await call()

    expect(res.status).toBe(409)
    expect(mocks.policyUpdateMany).not.toHaveBeenCalled()
    expect(mocks.logAudit).not.toHaveBeenCalled()
  })

  it("rejects a caller below INSURANCE_OFFICER", async () => {
    const { NextResponse } = await import("next/server")
    mocks.requireApiRole.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    })

    const res = await call()

    expect(res.status).toBe(403)
    expect(mocks.policyUpdateMany).not.toHaveBeenCalled()
  })

  it("404s a policy outside the caller's tenant", async () => {
    mocks.policyFindFirst.mockResolvedValue(null)

    const res = await call()

    expect(res.status).toBe(404)
    expect(mocks.policyUpdateMany).not.toHaveBeenCalled()
  })
})

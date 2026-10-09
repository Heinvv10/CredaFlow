import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  withTenantContext: vi.fn(),
  clientFindFirst: vi.fn(),
  policyFindFirst: vi.fn(),
  policyUpdateMany: vi.fn(),
  accessLogFindFirst: vi.fn(),
  logAudit: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findFirst: mocks.clientFindFirst },
    insurancePolicy: {
      findFirst: mocks.policyFindFirst,
      updateMany: mocks.policyUpdateMany,
    },
    documentAccessLog: { findFirst: mocks.accessLogFindFirst },
  },
}))
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>()
  return { AuditAction: actual.AuditAction, logAudit: mocks.logAudit }
})

import { POST } from "./route"

const ISSUED = new Date("2026-03-02T00:00:00.000Z")

function call(id = "policy-1") {
  return POST(new Request("http://localhost/x", { method: "POST" }), {
    params: Promise.resolve({ id }),
  })
}

describe("portal PPR acknowledgement", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.mockResolvedValue({ user: { email: "client@example.test" } })
    mocks.clientFindFirst.mockResolvedValue({ id: "client-1" })
    mocks.policyFindFirst.mockResolvedValue({
      id: "policy-1",
      pprIssuedAt: ISSUED,
      pprAcknowledgedAt: null,
      faisDisclosurePdfUrl: "/api/documents/doc-9/view",
    })
    mocks.accessLogFindFirst.mockResolvedValue({ id: "view-1" })
    mocks.policyUpdateMany.mockResolvedValue({ count: 1 })
  })

  it("rejects an unauthenticated caller without touching the policy", async () => {
    mocks.auth.mockResolvedValue(null)

    const res = await call()

    expect(res.status).toBe(401)
    expect(mocks.policyUpdateMany).not.toHaveBeenCalled()
  })

  it("404s another client's policy rather than acknowledging it", async () => {
    // Scoped lookup finds nothing because the row belongs to someone else.
    mocks.policyFindFirst.mockResolvedValue(null)

    const res = await call("someone-elses-policy")

    expect(res.status).toBe(404)
    expect(mocks.policyUpdateMany).not.toHaveBeenCalled()
    expect(mocks.logAudit).not.toHaveBeenCalled()
  })

  it("scopes the policy lookup to the caller's clientId and tenant", async () => {
    await call()

    expect(mocks.policyFindFirst.mock.calls[0][0]).toMatchObject({
      where: { id: "policy-1", clientId: "client-1", tenantId: "tenant-1" },
    })
  })

  // The disclosure must exist before it can be acknowledged, or the route
  // would manufacture the compliance record the FSCA return counts.
  it("refuses to acknowledge a disclosure that was never issued", async () => {
    mocks.policyFindFirst.mockResolvedValue({
      id: "policy-1",
      pprIssuedAt: null,
      pprAcknowledgedAt: null,
      faisDisclosurePdfUrl: "/api/documents/doc-9/view",
    })

    const res = await call()

    expect(res.status).toBe(409)
    expect(mocks.policyUpdateMany).not.toHaveBeenCalled()
    expect(mocks.logAudit).not.toHaveBeenCalled()
  })

  // A STANDALONE policy's disclosure url points at /api/insurance/disclosures/
  // <token>, which is requireApiRole("INSURANCE_OFFICER") with a 1h TTL — the
  // client gets a 403 and can never have read it. Accepting an acknowledgement
  // against that document would record the exact unevidenced attestation this
  // route exists to prevent.
  it("refuses to acknowledge a disclosure the client cannot open", async () => {
    mocks.policyFindFirst.mockResolvedValue({
      id: "policy-1",
      pprIssuedAt: ISSUED,
      pprAcknowledgedAt: null,
      faisDisclosurePdfUrl: "/api/insurance/disclosures/some-draft-token",
    })

    const res = await call()

    expect(res.status).toBe(409)
    expect(mocks.accessLogFindFirst).not.toHaveBeenCalled()
    expect(mocks.policyUpdateMany).not.toHaveBeenCalled()
    expect(mocks.logAudit).not.toHaveBeenCalled()
  })

  // The browser checkbox is the user agent asserting; this is the evidence.
  // A bare POST leaves no DocumentAccessLog row and must be rejected.
  it("refuses to acknowledge without a server-side record that the client viewed the document", async () => {
    mocks.accessLogFindFirst.mockResolvedValue(null)

    const res = await call()

    expect(res.status).toBe(422)
    expect(mocks.policyUpdateMany).not.toHaveBeenCalled()
    expect(mocks.logAudit).not.toHaveBeenCalled()
  })

  it("requires the view to be by this client, on that document, at or after issuance", async () => {
    await call()

    expect(mocks.accessLogFindFirst.mock.calls[0][0]).toMatchObject({
      where: {
        documentId: "doc-9",
        accessorType: "client",
        accessorId: "client-1",
        action: "view",
        createdAt: { gte: ISSUED },
      },
    })
  })

  it("writes the acknowledgement under a compare-and-set on the null timestamp", async () => {
    const res = await call()

    expect(res.status).toBe(200)
    expect(mocks.policyUpdateMany).toHaveBeenCalledOnce()
    const arg = mocks.policyUpdateMany.mock.calls[0][0]
    // Without pprAcknowledgedAt: null in the predicate, a replay would move an
    // already-recorded regulatory timestamp.
    expect(arg.where).toMatchObject({
      id: "policy-1",
      clientId: "client-1",
      tenantId: "tenant-1",
      pprAcknowledgedAt: null,
    })
    expect(arg.data.pprAcknowledgedBy).toBe("client-1")
    expect(arg.data.pprAcknowledgedAt).toBeInstanceOf(Date)
  })

  it("attributes the acknowledgement to the client and the portal channel in the audit row", async () => {
    await call()

    expect(mocks.logAudit).toHaveBeenCalledOnce()
    expect(mocks.logAudit.mock.calls[0][0]).toMatchObject({
      tenantId: "tenant-1",
      userEmail: "client@example.test",
      action: "INSURANCE_PPR_ACKNOWLEDGED",
      entity: "InsurancePolicy",
      entityId: "policy-1",
      newValue: expect.objectContaining({
        pprAcknowledgedBy: "client-1",
        channel: "CLIENT_PORTAL",
        // Without this the audit row names no particular document.
        disclosureDocumentId: "doc-9",
        priorViewLogId: "view-1",
      }),
    })
  })

  it("is idempotent: a second submit neither rewrites the timestamp nor re-audits", async () => {
    mocks.policyFindFirst.mockResolvedValue({
      id: "policy-1",
      pprIssuedAt: ISSUED,
      pprAcknowledgedAt: new Date("2026-03-05T00:00:00.000Z"),
      faisDisclosurePdfUrl: "/api/documents/doc-9/view",
    })

    const res = await call()
    const body = (await res.json()) as { alreadyAcknowledged?: boolean; acknowledgedAt?: string }

    expect(res.status).toBe(200)
    expect(body.alreadyAcknowledged).toBe(true)
    expect(body.acknowledgedAt).toBe("2026-03-05T00:00:00.000Z")
    expect(mocks.policyUpdateMany).not.toHaveBeenCalled()
    expect(mocks.logAudit).not.toHaveBeenCalled()
  })

  // Two concurrent submits both pass the read but only one can win the CAS.
  it("does not audit a lost race, so one acknowledgement yields one audit row", async () => {
    mocks.policyUpdateMany.mockResolvedValue({ count: 0 })
    mocks.policyFindFirst
      .mockResolvedValueOnce({ id: "policy-1", pprIssuedAt: ISSUED, pprAcknowledgedAt: null, faisDisclosurePdfUrl: "/api/documents/doc-9/view" })
      .mockResolvedValueOnce({ pprAcknowledgedAt: new Date("2026-03-05T00:00:00.000Z") })

    const res = await call()
    const body = (await res.json()) as { alreadyAcknowledged?: boolean }

    expect(res.status).toBe(200)
    expect(body.alreadyAcknowledged).toBe(true)
    expect(mocks.logAudit).not.toHaveBeenCalled()
  })
})

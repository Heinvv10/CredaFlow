/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findMany: vi.fn() },
    insurancePolicy: { findMany: vi.fn(), update: vi.fn() },
    advisorCommission: { updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
    crmActivity: { create: vi.fn() },
    notificationLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
      insurancePolicy: { update: vi.fn() },
      advisorCommission: { updateMany: vi.fn() },
    })),
  },
}))

import { verifyCronSecret } from "@/lib/cron-auth"
import { prisma } from "@/lib/prisma"
import { POST } from "./route"

const req = () => new NextRequest(new URL("http://localhost/api/cron/insurance-renewal"))

const lapseCandidate = (id: string) => ({ id, tenantId: "tenant-1", policyNumber: `POL-${id}` })

describe("POST /api/cron/insurance-renewal", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyCronSecret).mockReturnValue(null as unknown as NextResponse)
    ;(prisma.tenant.findMany as any).mockResolvedValue([{ id: "tenant-1" }])
    ;(prisma.insurancePolicy.findMany as any)
      .mockResolvedValueOnce([]) // lapse-eligible
      .mockResolvedValueOnce([]) // renewal-due
    ;(prisma.auditLog.create as any).mockResolvedValue({})
    ;(prisma.crmActivity.create as any).mockResolvedValue({})
    ;(prisma.notificationLog.create as any).mockResolvedValue({})
    ;(prisma.$transaction as any).mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        insurancePolicy: { update: vi.fn() },
        advisorCommission: { updateMany: vi.fn() },
      })
    )
  })

  it("returns 401 when CRON_SECRET is missing/wrong", async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    const res = await POST(req())
    expect(res.status).toBe(401)
    expect(prisma.insurancePolicy.findMany).not.toHaveBeenCalled()
  })

  // The `$transaction` (lapse + clawback) has its own per-policy catch that
  // logs and continues — a hardcoded ok:true would let a policy that keeps
  // failing to lapse stay ACTIVE and collectible past its grace period,
  // invisible to the systemd wrapper (`curl -fsS` never parses this body).
  it("reports ok:false and 503 when a policy fails to lapse", async () => {
    ;(prisma.insurancePolicy.findMany as any).mockReset()
    ;(prisma.insurancePolicy.findMany as any)
      .mockResolvedValueOnce([lapseCandidate("p1"), lapseCandidate("p2")])
      .mockResolvedValueOnce([])
    ;(prisma.$transaction as any)
      .mockImplementationOnce(async (fn: (tx: unknown) => unknown) =>
        fn({ insurancePolicy: { update: vi.fn() }, advisorCommission: { updateMany: vi.fn() } })
      )
      .mockRejectedValueOnce(new Error("db write failed"))

    const res = await POST(req())
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.lapsed).toBe(1)
    expect(json.lapseFailed).toBe(1)
    expect(res.status).toBe(503)
  })

  it("reports ok:false and 503 when a renewal notice fails to write", async () => {
    ;(prisma.insurancePolicy.findMany as any).mockReset()
    ;(prisma.insurancePolicy.findMany as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "r1", tenantId: "tenant-1", clientId: "c1", policyNumber: "POL-R1", type: "LIFE", renewalDate: new Date(), sumAssured: 1000, client: {} },
      ])
    ;(prisma.crmActivity.create as any).mockRejectedValue(new Error("write failed"))

    const res = await POST(req())
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.processed).toBe(1)
    expect(json.renewed).toBe(0)
    expect(json.actionFailed).toBe(1)
    expect(res.status).toBe(503)
  })

  it("reports ok:true and 200 when there is nothing to lapse or renew (empty sweep)", async () => {
    const res = await POST(req())
    const json = await res.json()
    expect(json).toMatchObject({ ok: true, lapsed: 0, lapseFailed: 0, processed: 0, renewed: 0, actionFailed: 0 })
    expect(res.status).toBe(200)
  })

  // InsurancePolicy is a tenant-scope model and a cron has no tenant frame:
  // every query must name its tenant or the extension throws missing-context.
  // Each tenant is swept on its own, and nothing it writes names another.
  it("sweeps every tenant with an explicit tenantId on each policy query and write", async () => {
    ;(prisma.tenant.findMany as any).mockResolvedValue([{ id: "tenant-a" }, { id: "tenant-b" }])
    ;(prisma.insurancePolicy.findMany as any).mockReset()
    ;(prisma.insurancePolicy.findMany as any).mockImplementation(async (args: any) => {
      const tenantId = args.where.tenantId as string
      return args.where.premiumPayments
        ? [{ id: `lapse-${tenantId}`, tenantId, policyNumber: `POL-L-${tenantId}` }]
        : [{ id: `renew-${tenantId}`, tenantId, clientId: `client-${tenantId}`, policyNumber: `POL-R-${tenantId}`, type: "LIFE", renewalDate: new Date(), sumAssured: 1000, client: {} }]
    })
    const txUpdates: any[] = []
    ;(prisma.$transaction as any).mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        insurancePolicy: { update: vi.fn(async (args: any) => { txUpdates.push(args) }) },
        advisorCommission: { updateMany: vi.fn() },
      })
    )

    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, lapsed: 2, processed: 2, renewed: 2 })

    const findWheres = (prisma.insurancePolicy.findMany as any).mock.calls.map(([args]: any[]) => args.where)
    expect(findWheres).toHaveLength(4)
    expect(findWheres.map((w: any) => w.tenantId).sort()).toEqual(["tenant-a", "tenant-a", "tenant-b", "tenant-b"])
    expect(txUpdates.map((u) => u.where)).toEqual([
      { id: "lapse-tenant-a", tenantId: "tenant-a" },
      { id: "lapse-tenant-b", tenantId: "tenant-b" },
    ])
    const writes = [
      ...(prisma.auditLog.create as any).mock.calls,
      ...(prisma.crmActivity.create as any).mock.calls,
      ...(prisma.notificationLog.create as any).mock.calls,
    ].map(([args]: any[]) => args.data)
    expect(writes).toHaveLength(6)
    for (const data of writes) {
      const id = (data.entityId ?? data.clientId) as string
      expect(id.endsWith(data.tenantId)).toBe(true)
    }
  })

  // Every policy row carries its own tenant, so the sweep has no use for the
  // deployment's default tenant and must not depend on it being configured.
  it("runs with NEXT_PUBLIC_TENANT_SLUG unset", async () => {
    const saved = process.env.NEXT_PUBLIC_TENANT_SLUG
    delete process.env.NEXT_PUBLIC_TENANT_SLUG
    try {
      ;(prisma.insurancePolicy.findMany as any).mockReset()
      ;(prisma.insurancePolicy.findMany as any)
        .mockResolvedValueOnce([lapseCandidate("p1")])
        .mockResolvedValueOnce([
          { id: "r1", tenantId: "tenant-1", clientId: "c1", policyNumber: "POL-R1", type: "LIFE", renewalDate: new Date(), sumAssured: 1000, client: {} },
        ])

      const res = await POST(req())
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, lapsed: 1, renewed: 1 })
      expect((prisma.auditLog.create as any).mock.calls[0][0].data.tenantId).toBe("tenant-1")
      expect((prisma.crmActivity.create as any).mock.calls[0][0].data.tenantId).toBe("tenant-1")
      expect((prisma.notificationLog.create as any).mock.calls[0][0].data.tenantId).toBe("tenant-1")
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_TENANT_SLUG
      else process.env.NEXT_PUBLIC_TENANT_SLUG = saved
    }
  })
})

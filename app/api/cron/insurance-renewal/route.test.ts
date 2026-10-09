/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: vi.fn() }))
vi.mock("@/lib/tenant", () => ({ getDefaultTenantId: vi.fn(async () => "tenant-1") }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
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
})

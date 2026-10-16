import { NextRequest } from "next/server"
import { describe, expect, it, vi } from "vitest"

// The demo simulator's claim chain must stay a sequence the claims route
// accepts. #139's re-review: it sent { status: "PAID" } through the generic
// update, which the route now refuses (PAID only via "mark_paid").
const claim = vi.hoisted(() => ({
  row: { id: "claim-1", status: "SUBMITTED", claimAmount: "10000.00", approvedAmount: null as unknown, notes: null as string | null, policy: { sumAssured: "20000.00" } },
}))
const matches = (where: { status?: string | { in: string[] } }) =>
  !where.status || (typeof where.status === "string" ? where.status === claim.row.status : where.status.in.includes(claim.row.status))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) },
    insuranceClaim: {
      findFirst: async () => claim.row,
      updateMany: async ({ where, data }: { where: { status?: string | { in: string[] } }; data: Record<string, unknown> }) => {
        if (!matches(where)) return { count: 0 }
        claim.row = { ...claim.row, ...data, approvedAmount: data.approvedAmount === undefined ? claim.row.approvedAmount : { toFixed: () => Number(data.approvedAmount).toFixed(2) } } as typeof claim.row
        return { count: 1 }
      },
    },
  },
}))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: async () => ({ user: { id: "io-1", email: "io@sim.invalid", role: "INSURANCE_OFFICER" } }) }))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/audit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/audit")>()), logAudit: vi.fn() }))

import { PATCH } from "@/app/api/insurance/claims/[id]/route"
import { CLAIM_1_UPDATES } from "./insurance"

describe("the demo's first insurance claim", () => {
  it("runs lodged → under review → approved → paid → noted through the claims route", async () => {
    for (const [, body] of CLAIM_1_UPDATES) {
      const res = await PATCH(
        new NextRequest("http://localhost/api/insurance/claims/claim-1", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        { params: Promise.resolve({ id: "claim-1" }) },
      )
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 200])
    }
    expect(claim.row).toMatchObject({ status: "PAID", notes: "Insurer paid R10 000 to the beneficiary." })
  })
})

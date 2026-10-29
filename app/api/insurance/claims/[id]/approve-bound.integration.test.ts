/**
 * Real-Postgres test of the claim approval bound (Fair Score audit,
 * 2026-10-16: "Claim approval accepted Approved Amount R1,000,010,000.00 on a
 * R10,000 claim"). The route compares Decimal columns in exact cents and
 * re-asserts both bounds in its write through a relation filter; a mocked
 * Prisma can execute neither. Only auth and the tenant frame are stubbed.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run "app/api/insurance/claims/[id]/approve-bound.integration.test.ts"
 */
import { randomBytes } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"

const { ctx } = vi.hoisted(() => ({ ctx: { tenantId: "", userId: "" } }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({
    user: { id: ctx.userId, email: "claims-it@test.invalid", role: "INSURANCE_OFFICER", tenantId: ctx.tenantId },
  })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: async (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) =>
    await runWithTenant(ctx.tenantId, () => handler({ id: ctx.tenantId })),
}))

import { PATCH } from "./route"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

let claimId = ""

function approve(approvedAmount: unknown) {
  return PATCH(
    new NextRequest(`http://localhost/api/insurance/claims/${claimId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve", approvedAmount }),
    }),
    { params: Promise.resolve({ id: claimId }) },
  )
}

async function stored() {
  return db.insuranceClaim.findUniqueOrThrow({ where: { id: claimId }, select: { status: true, approvedAmount: true } })
}

suite("PATCH /api/insurance/claims/[id] approve — bounded on a real database", () => {
  beforeAll(async () => {
    const token = randomBytes(6).toString("hex")
    const tenant = await db.tenant.create({ data: { slug: `claims-it-${token}`, name: "Claims IT", status: "ACTIVE" } })
    ctx.tenantId = tenant.id
    await db.tenantConfig.create({ data: { tenantId: tenant.id, featureIms: true } })
    const user = await db.user.create({
      data: { tenantId: tenant.id, email: `${token}@claims-it.invalid`, password: "x", role: "INSURANCE_OFFICER" },
    })
    ctx.userId = user.id
    const client = await db.client.create({
      data: {
        tenantId: tenant.id, idNumber: `91${token}0`, firstName: "Synthetic", lastName: "Claimant",
        email: `${token}@client.invalid`, phone: "0820000000",
      },
    })
    const policy = await db.insurancePolicy.create({
      data: {
        tenantId: tenant.id, clientId: client.id, policyNumber: `CLIT-${token}`, type: "FUNERAL_COVER", status: "ACTIVE",
        premiumAmount: "118.00", sumAssured: "20000.00",
        startDate: new Date("2026-01-01T00:00:00Z"), renewalDate: new Date("2027-01-01T00:00:00Z"),
        policySource: "STANDALONE", faisDisclosureAt: new Date("2026-01-01T00:00:00Z"),
        faisDisclosurePdfUrl: `/synthetic/${token}.pdf`,
      },
    })
    const claim = await db.insuranceClaim.create({
      data: { tenantId: tenant.id, policyId: policy.id, claimNumber: `CLIT-CLM-${token}`, claimAmount: "10000.00" },
    })
    claimId = claim.id
  })

  afterAll(async () => {
    if (ctx.tenantId) {
      const tenantId = ctx.tenantId
      await purgeAuditRowsForTest(db, { tenantId })
      await db.insuranceClaim.deleteMany({ where: { tenantId } })
      await db.insurancePolicy.deleteMany({ where: { tenantId } })
      await db.client.deleteMany({ where: { tenantId } })
      await db.user.deleteMany({ where: { tenantId } })
      await db.tenantConfig.deleteMany({ where: { tenantId } })
      await db.tenant.delete({ where: { id: tenantId } })
    }
    await db.$disconnect()
  })

  it("refuses the audit's R1,000,010,000.00 on a R10,000 claim and leaves the claim untouched", async () => {
    const res = await approve(1_000_010_000)
    expect(res.status).toBe(422)
    expect(await stored()).toEqual({ status: "SUBMITTED", approvedAmount: null })
  })

  it("refuses one cent over the claimed amount", async () => {
    expect((await approve(10_000.01)).status).toBe(422)
    expect((await stored()).approvedAmount).toBeNull()
  })

  it("refuses more than the sum assured when the claim asks for more than the cover", async () => {
    await db.insuranceClaim.update({ where: { id: claimId }, data: { claimAmount: "25000.00" } })
    try {
      const res = await approve(20_000.01)
      expect(res.status).toBe(422)
      expect((await res.json()).error).toMatch(/sum assured/)
      expect((await stored()).approvedAmount).toBeNull()
    } finally {
      await db.insuranceClaim.update({ where: { id: claimId }, data: { claimAmount: "10000.00" } })
    }
  })

  it("re-checks the bound in the write: a claim lowered after the route's read is not approved", async () => {
    // A test hook between the route's read and its write: the read returns as
    // it was, then the claim amount drops to R4,000 before updateMany runs, so
    // only the write's own WHERE can refuse R5,000.
    const { prisma } = await import("@/lib/prisma")
    const claims = prisma.insuranceClaim as unknown as { findFirst: (args: unknown) => Promise<unknown> }
    const read = claims.findFirst.bind(claims)
    const spy = vi.spyOn(claims, "findFirst").mockImplementationOnce(async (args: unknown) => {
      const before = await read(args)
      await db.insuranceClaim.update({ where: { id: claimId }, data: { claimAmount: "4000.00" } })
      return before
    })
    try {
      expect((await approve(5_000)).status).toBe(409)
      expect(spy).toHaveBeenCalled()
      expect(await stored()).toEqual({ status: "SUBMITTED", approvedAmount: null })
    } finally {
      spy.mockRestore()
      await db.insuranceClaim.update({ where: { id: claimId }, data: { claimAmount: "10000.00" } })
    }
  })

  it("refuses a bare status APPROVED with 400 and writes nothing", async () => {
    const res = await PATCH(
      new NextRequest(`http://localhost/api/insurance/claims/${claimId}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: null, status: "APPROVED" }),
      }),
      { params: Promise.resolve({ id: claimId }) },
    )
    expect(res.status).toBe(400)
    expect(await stored()).toEqual({ status: "SUBMITTED", approvedAmount: null })
  })

  it("approves exactly the claimed amount, stored to the cent and audited", async () => {
    const res = await approve(10_000)
    expect(res.status).toBe(200)
    const claim = await stored()
    expect(claim.status).toBe("APPROVED")
    expect(claim.approvedAmount?.toFixed(2)).toBe("10000.00")
    expect(await db.auditLog.count({ where: { tenantId: ctx.tenantId, entityId: claimId, action: "INSURANCE_CLAIM_APPROVED" } })).toBe(1)
  })

  it("refuses to approve the claim a second time (409)", async () => {
    expect((await approve(1_000)).status).toBe(409)
    expect((await stored()).approvedAmount?.toFixed(2)).toBe("10000.00")
  })
})

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createHmac } from "node:crypto"
import { prisma } from "../prisma"
import { withoutTenantScope, runWithTenant } from "../tenant-scope"
import { POST } from "../../app/api/portal/payment/webhook/route"

const HAS_DB = !!process.env.DATABASE_URL
const d = HAS_DB ? describe : describe.skip

const STAMP = `${Date.now()}-${process.pid}`
const SECRET = "test-webhook-secret"
const TENANT_SLUG = `test-wh-${STAMP}`

let originalSecret: string | undefined
let originalTenantSlug: string | undefined
let tenantId = ""
let clientId = ""
let loanId = ""
let stitchPaymentId = ""
let stitchExternalId = ""

function makeRequest(body: string, signature: string): Request {
  return new Request("http://localhost/api/portal/payment/webhook", {
    method: "POST",
    headers: {
      "x-stitch-signature": signature,
      "content-type": "application/json",
    },
    body,
  })
}

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex")
}

d("Stitch webhook — replay protection (integration)", () => {
  beforeAll(async () => {
    // Patch env vars before seeding so webhook handler resolves the right tenant
    originalSecret = process.env.STITCH_WEBHOOK_SECRET
    originalTenantSlug = process.env.NEXT_PUBLIC_TENANT_SLUG
    process.env.STITCH_WEBHOOK_SECRET = SECRET
    process.env.NEXT_PUBLIC_TENANT_SLUG = TENANT_SLUG

    // Create test tenant
    await withoutTenantScope(async () => {
      const tenant = await prisma.tenant.create({
        data: { slug: TENANT_SLUG, name: "Test Webhook Tenant", status: "ACTIVE" },
      })
      tenantId = tenant.id
    })

    let productId = ""
    let applicationId = ""

    await runWithTenant(tenantId, async () => {
      // Client
      const client = await prisma.client.create({
        data: {
          tenantId,
          firstName: "Webhook",
          lastName: "Test",
          email: `wh-${STAMP}@example.com`,
          idNumber: `WH${STAMP}`.slice(0, 13),
          phone: "0820000099",
        },
      })
      clientId = client.id

      // LoanProduct — always create fresh for this test run
      const product = await prisma.loanProduct.create({
        data: {
          tenantId,
          code: `WHTEST${STAMP}`.slice(0, 20),
          name: "Webhook Test Product",
          productType: "MICRO",
          minAmount: 100,
          maxAmount: 10000,
          minTermDays: 30,
          maxTermDays: 365,
          interestRatePm: 5,
          interestModel: "FLAT",
          active: true,
        },
      })
      productId = product.id

      // LoanApplication (required FK from Loan)
      const application = await prisma.loanApplication.create({
        data: {
          tenantId,
          reference: `LA-WH-${STAMP}`,
          clientId,
          productId,
          appliedAmount: 1000,
          appliedTermDays: 180,
          status: "DISBURSED",
          repaymentMethod: "EFT",
        },
      })
      applicationId = application.id

      // Loan
      const loan = await prisma.loan.create({
        data: {
          tenantId,
          reference: `LN-WH-${STAMP}`,
          applicationId,
          clientId,
          productId,
          principal: 1000,
          totalInterest: 300,
          initiationFee: 0,
          totalRepayable: 1300,
          outstandingPrincipal: 1000,
          status: "ACTIVE",
          startDate: new Date(),
          maturityDate: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
          interestRatePm: 5,
          interestModel: "FLAT",
          monthlyServiceFee: 0,
        },
      })
      loanId = loan.id
    })

    // StitchPaymentRequest has no tenantId — use withoutTenantScope
    await withoutTenantScope(async () => {
      stitchExternalId = `stitch-${STAMP}`
      const spr = await prisma.stitchPaymentRequest.create({
        data: {
          stitchId: stitchExternalId,
          loanId,
          clientId,
          amount: 200,
          externalReference: `ref-${STAMP}`,
          redirectUrl: "https://example.com/redirect",
          stitchUrl: "https://stitch.money/pay/test",
          status: "PENDING",
        },
      })
      stitchPaymentId = spr.id
    })
  })

  afterAll(async () => {
    // Restore env vars
    if (originalSecret === undefined) delete process.env.STITCH_WEBHOOK_SECRET
    else process.env.STITCH_WEBHOOK_SECRET = originalSecret

    if (originalTenantSlug === undefined) delete process.env.NEXT_PUBLIC_TENANT_SLUG
    else process.env.NEXT_PUBLIC_TENANT_SLUG = originalTenantSlug

    await withoutTenantScope(async () => {
      if (stitchPaymentId) {
        await prisma.stitchPaymentRequest.delete({ where: { id: stitchPaymentId } }).catch(() => {})
      }
      if (loanId) {
        await prisma.payment.deleteMany({ where: { loanId } }).catch(() => {})
        await prisma.repaymentSchedule.deleteMany({ where: { loanId } }).catch(() => {})
      }
    })

    await withoutTenantScope(async () => {
      // Must delete loan before application before product before client before tenant
      // (FK chain: loan → application → product; loan → client; application → client)
      if (loanId) await prisma.loan.delete({ where: { id: loanId } }).catch(() => {})

      // Find applicationId from stamp-unique reference and delete
      const app = await prisma.loanApplication
        .findUnique({ where: { reference: `LA-WH-${STAMP}` } })
        .catch(() => null)
      if (app) await prisma.loanApplication.delete({ where: { id: app.id } }).catch(() => {})

      // Find product
      const prod = await prisma.loanProduct
        .findFirst({ where: { code: { startsWith: "WHTEST" }, tenantId } })
        .catch(() => null)
      if (prod) await prisma.loanProduct.delete({ where: { id: prod.id } }).catch(() => {})

      if (clientId) await prisma.client.delete({ where: { id: clientId } }).catch(() => {})
      if (tenantId) await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {})
    })
  })

  it("first webhook POST creates exactly one Payment row and marks request COMPLETED", async () => {
    const body = JSON.stringify({ type: "payment.completed", data: { id: stitchExternalId } })
    const res = await POST(makeRequest(body, sign(body)))
    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.ok).toBe(true)
    expect(json.replayed).toBeUndefined()

    const paymentsCount = await withoutTenantScope(async () =>
      prisma.payment.count({ where: { loanId } })
    )
    expect(paymentsCount).toBe(1)

    const spr = await withoutTenantScope(async () =>
      prisma.stitchPaymentRequest.findUnique({ where: { id: stitchPaymentId } })
    )
    expect(spr?.status).toBe("COMPLETED")
  })

  it("replayed webhook POST returns ok:true, replayed:true and does NOT create a second Payment", async () => {
    const body = JSON.stringify({ type: "payment.completed", data: { id: stitchExternalId } })
    const res = await POST(makeRequest(body, sign(body)))
    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.ok).toBe(true)
    expect(json.replayed).toBe(true)

    const paymentsCount = await withoutTenantScope(async () =>
      prisma.payment.count({ where: { loanId } })
    )
    expect(paymentsCount).toBe(1)
  })

  it("invalid signature returns 401 and does not affect state", async () => {
    const body = JSON.stringify({ type: "payment.completed", data: { id: stitchExternalId } })
    const res = await POST(makeRequest(body, "deadbeef"))
    expect(res.status).toBe(401)

    const paymentsCount = await withoutTenantScope(async () =>
      prisma.payment.count({ where: { loanId } })
    )
    expect(paymentsCount).toBe(1)
  })

  it("unknown stitchId returns 200 ok with no Payment created", async () => {
    const body = JSON.stringify({ type: "payment.completed", data: { id: `nope-${STAMP}` } })
    const res = await POST(makeRequest(body, sign(body)))
    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.ok).toBe(true)
    // Still only one Payment from the first test
    const paymentsCount = await withoutTenantScope(async () =>
      prisma.payment.count({ where: { loanId } })
    )
    expect(paymentsCount).toBe(1)
  })
})

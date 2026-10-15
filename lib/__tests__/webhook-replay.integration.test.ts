/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createHmac } from "node:crypto"
import { prisma } from "../prisma"
import { withoutTenantScope } from "../tenant-scope"
import { createApprovedPasqV3Application, bookLoan } from "../compliance/pasq-v3-application.integration-fixture"
import { POST } from "../../app/api/portal/payment/webhook/route"
import { GET as callback } from "../../app/api/portal/payment/callback/route"

// Opt-in: needs a fully migrated database. See "Integration tests" in CLAUDE.md.
//   RUN_WEBHOOK_REPLAY_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/__tests__/webhook-replay.integration.test.ts
const d = process.env.RUN_WEBHOOK_REPLAY_IT === "1" ? describe : describe.skip

const STAMP = `${Date.now()}-${process.pid}`
const SECRET = "test-webhook-secret"

let originalSecret: string | undefined
let originalTenantSlug: string | undefined
let tenantId = ""
let decoyTenantId = ""
let clientId = ""
let loanId = ""
let stitchPaymentId = ""
let stitchExternalId = ""
let callbackPaymentId = ""

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
    originalSecret = process.env.STITCH_WEBHOOK_SECRET
    originalTenantSlug = process.env.NEXT_PUBLIC_TENANT_SLUG
    process.env.STITCH_WEBHOOK_SECRET = SECRET

    // An approved application needs a locked PASQ v3 document (trigger +
    // LoanApplication_approved_status_requires_pasq CHECK), so the shared
    // fixture builds the tenant, client, product, application and booked loan.
    const scenario = await createApprovedPasqV3Application("webhook-replay")
    tenantId = scenario.tenantId
    clientId = scenario.clientId
    loanId = await bookLoan(scenario)

    // Point the default tenant at a DIFFERENT tenant. The webhook must take
    // its tenant from the loan; if it ever falls back to the default tenant,
    // the tenant assertions below go red instead of passing by coincidence.
    const decoy = await withoutTenantScope(async () =>
      prisma.tenant.create({
        data: { slug: `wh-decoy-${STAMP}`, name: "Webhook default-tenant decoy" },
      })
    )
    decoyTenantId = decoy.id
    process.env.NEXT_PUBLIC_TENANT_SLUG = decoy.slug

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

    // Only the throwaway rows we own are removed; the fixture tenant, loan,
    // Payment and signed PASQ evidence are left on the throwaway DB.
    await withoutTenantScope(async () => {
      if (stitchPaymentId) {
        await prisma.stitchPaymentRequest.delete({ where: { id: stitchPaymentId } })
      }
      if (callbackPaymentId) {
        await prisma.stitchPaymentRequest.delete({ where: { id: callbackPaymentId } })
      }
      if (decoyTenantId) await prisma.tenant.delete({ where: { id: decoyTenantId } })
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

    const payment = await withoutTenantScope(async () =>
      prisma.payment.findFirstOrThrow({ where: { loanId } })
    )
    expect(payment.tenantId).toBe(tenantId)

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

  // Stitch redirects the payer's browser to the callback, usually before its
  // webhook lands. The callback used to mark the request COMPLETED from the
  // query string, so the webhook took it for a replay and booked no receipt.
  it("a browser callback ahead of the webhook does not swallow the receipt", async () => {
    const callbackStitchId = `stitch-cb-${STAMP}`
    await withoutTenantScope(async () => {
      const spr = await prisma.stitchPaymentRequest.create({
        data: {
          stitchId: callbackStitchId, loanId, clientId, amount: 150,
          externalReference: `ref-cb-${STAMP}`, redirectUrl: "https://example.com/redirect",
          stitchUrl: "https://stitch.money/pay/test-cb", status: "PENDING",
        },
      })
      callbackPaymentId = spr.id
    })

    const cb = await callback(new Request(`http://localhost/api/portal/payment/callback?id=${callbackStitchId}&status=complete`))
    expect(cb.status).toBe(307)

    const body = JSON.stringify({ type: "payment.completed", data: { id: callbackStitchId } })
    const res = await POST(makeRequest(body, sign(body)))
    expect(await res.json()).toEqual({ ok: true })

    const receipts = await withoutTenantScope(async () =>
      prisma.payment.count({ where: { loanId, notes: { contains: callbackStitchId } } })
    )
    expect(receipts).toBe(1)
  })
})

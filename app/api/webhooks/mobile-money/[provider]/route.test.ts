import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { ingest, withTenantContext } = vi.hoisted(() => ({
  ingest: vi.fn(),
  withTenantContext: vi.fn((_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t_host" })),
}))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/tenant", () => ({ withTenantContext }))
vi.mock("@/lib/mobile-money/c2b-ingest", () => ({ ingestMobileMoneyCallback: ingest }))

import { MAX_CALLBACK_BYTES, POST } from "./route"
import { signSimulatedCallback, simulatedC2BPayment } from "@/lib/mobile-money/providers/simulated"

const call = (provider: string, rawBody: string, headers: Headers) =>
  POST(new NextRequest(`http://acme.localhost/api/webhooks/mobile-money/${provider}`, { method: "POST", body: rawBody, headers }),
    { params: Promise.resolve({ provider }) })
const payment = (tenantId = "t_host") => simulatedC2BPayment({ tenantId, billRef: "NRB-LN-1", amountCents: 10_000, msisdn: "254712345678" })

describe("POST /api/webhooks/mobile-money/[provider]", () => {
  beforeEach(() => {
    vi.stubEnv("SIMULATED_MPESA_WEBHOOK_SECRET", "route-secret")
    ingest.mockReset().mockResolvedValue({ outcome: "BOOKED", transactionId: "mm1", paymentId: "p1" })
    withTenantContext.mockClear()
  })
  afterEach(() => { vi.unstubAllEnvs() })

  it("answers 401 to a request without the signature header, before resolving a tenant or reading the body", async () => {
    const good = payment()
    const unsigned = new Headers(good.headers)
    unsigned.delete("x-simulated-signature")
    const req = new NextRequest("http://acme.localhost/api/webhooks/mobile-money/simulated", { method: "POST", body: good.rawBody, headers: unsigned })
    const text = vi.spyOn(req, "text")
    const res = await POST(req, { params: Promise.resolve({ provider: "simulated" }) })
    expect(res.status).toBe(401)
    expect(text).not.toHaveBeenCalled()
    expect(withTenantContext).not.toHaveBeenCalled()
  })

  it("answers 413 to a declared body above the limit, without reading it", async () => {
    const good = payment()
    const big = new Headers(good.headers)
    big.set("content-length", String(MAX_CALLBACK_BYTES + 1))
    const req = new NextRequest("http://acme.localhost/api/webhooks/mobile-money/simulated", { method: "POST", body: good.rawBody, headers: big })
    const text = vi.spyOn(req, "text")
    expect((await POST(req, { params: Promise.resolve({ provider: "simulated" }) })).status).toBe(413)
    expect(text).not.toHaveBeenCalled()
  })

  it("answers 413 to an undeclared body above the limit", async () => {
    const good = payment()
    expect((await call("simulated", "x".repeat(MAX_CALLBACK_BYTES + 1), good.headers)).status).toBe(413)
    expect(ingest).not.toHaveBeenCalled()
  })

  it("answers 401 to a bad signature and ingests nothing", async () => {
    const good = payment()
    const ts = Number(good.headers.get("x-simulated-timestamp"))
    const forged = new Headers(good.headers)
    forged.set("x-simulated-signature", signSimulatedCallback(good.rawBody, "attacker-secret", ts, "t_host"))
    expect((await call("simulated", good.rawBody, forged)).status).toBe(401)
    expect(ingest).not.toHaveBeenCalled()
  })

  it("answers 401 to a callback signed for another lender than the host names", async () => {
    const other = payment("t_other")
    expect((await call("simulated", other.rawBody, other.headers)).status).toBe(401)
    expect(ingest).not.toHaveBeenCalled()
  })

  it("answers 404 for a provider it does not know", async () => {
    const good = payment()
    expect((await call("daraja", good.rawBody, good.headers)).status).toBe(404)
  })

  it("ingests a verified callback for the host's tenant and says only what happened", async () => {
    const good = payment()
    const res = await call("simulated", good.rawBody, good.headers)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ResultCode: 0, ResultDesc: "Accepted", outcome: "BOOKED" })
    expect(ingest).toHaveBeenCalledTimes(1)
    expect(ingest.mock.calls[0][1]).toMatchObject({ tenantId: "t_host", callback: { kind: "C2B", amountCents: 10_000, msisdnLast4: "5678" } })
  })
})

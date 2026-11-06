import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { ingest, withTenantContext } = vi.hoisted(() => ({
  ingest: vi.fn(),
  withTenantContext: vi.fn((_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t_host" })),
}))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/tenant", () => ({ withTenantContext }))
vi.mock("@/lib/mobile-money/c2b-ingest", () => ({ ingestMobileMoneyCallback: ingest }))

import { POST } from "./route"
import { signSimulatedCallback, simulatedC2BPayment } from "@/lib/mobile-money/providers/simulated"

const call = (provider: string, rawBody: string, headers: Headers) =>
  POST(new NextRequest(`http://acme.localhost/api/webhooks/mobile-money/${provider}`, { method: "POST", body: rawBody, headers }),
    { params: Promise.resolve({ provider }) })

describe("POST /api/webhooks/mobile-money/[provider]", () => {
  beforeEach(() => {
    vi.stubEnv("SIMULATED_MPESA_WEBHOOK_SECRET", "route-secret")
    ingest.mockReset().mockResolvedValue({ outcome: "BOOKED", transactionId: "mm1", paymentId: "p1" })
    withTenantContext.mockClear()
  })
  afterEach(() => { vi.unstubAllEnvs() })

  it("answers 401 to a bad signature, before resolving a tenant or ingesting anything", async () => {
    const good = simulatedC2BPayment({ billRef: "NRB-LN-1", amountCents: 10_000, msisdn: "254712345678" })
    const ts = Number(good.headers.get("x-simulated-timestamp"))
    const forged = new Headers(good.headers)
    forged.set("x-simulated-signature", signSimulatedCallback(good.rawBody, "attacker-secret", ts))
    const res = await call("simulated", good.rawBody, forged)
    expect(res.status).toBe(401)
    expect(withTenantContext).not.toHaveBeenCalled()
    expect(ingest).not.toHaveBeenCalled()
  })

  it("answers 401 to an unsigned body", async () => {
    const res = await call("simulated", JSON.stringify({ type: "C2B" }), new Headers())
    expect(res.status).toBe(401)
    expect(ingest).not.toHaveBeenCalled()
  })

  it("answers 404 for a provider it does not know", async () => {
    const good = simulatedC2BPayment({ billRef: "NRB-LN-1", amountCents: 10_000, msisdn: "254712345678" })
    expect((await call("daraja", good.rawBody, good.headers)).status).toBe(404)
  })

  it("ingests a verified callback for the tenant the host names, not one in the body", async () => {
    const good = simulatedC2BPayment({ billRef: "NRB-LN-1", amountCents: 10_000, msisdn: "254712345678" })
    const res = await call("simulated", good.rawBody, good.headers)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ResultCode: 0, outcome: "BOOKED" })
    expect(ingest).toHaveBeenCalledTimes(1)
    expect(ingest.mock.calls[0][1]).toMatchObject({ tenantId: "t_host", callback: { kind: "C2B", amountCents: 10_000, msisdnLast4: "5678" } })
  })
})

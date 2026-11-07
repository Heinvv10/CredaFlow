import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { NextRequest } from "next/server"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"

const mocks = vi.hoisted(() => ({ order: [] as string[], instance: "KE" as "KE" | "LS" | "ZA" }))

// A cold process has loaded nothing; the first ensureActiveJurisdiction() adopts the instance row, as in production.
vi.mock("@/lib/jurisdiction/load.server", () => ({
  ensureActiveJurisdiction: async () => {
    mocks.order.push("ensure")
    const currency = { KE: "KES", LS: "LSL", ZA: "ZAR" }[mocks.instance] as "KES" | "LSL" | "ZAR"
    setActiveJurisdiction({ jurisdiction: mocks.instance, currency })
    return {}
  },
}))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: async () => null }))
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => { mocks.order.push("rate-limit"); return { allowed: true } },
  callerIp: () => "127.0.0.1",
  recordedCallerIp: () => null,
}))
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: async () => ({ ok: true }) }))
vi.mock("@/lib/learning-loop/submission-refusal", () => ({ recordSubmissionRefusal: vi.fn() }))

import { POST } from "./route"

const BODY = { firstName: "Thandi", lastName: "Mokoena", phone: "0712345678", productType: "PERSONAL" }
const call = (idNumber: string) => POST({ json: async () => ({ ...BODY, idNumber }), headers: new Headers() } as unknown as NextRequest)

beforeEach(() => { mocks.order.length = 0; mocks.instance = "KE"; resetActiveJurisdiction() })
afterEach(() => resetActiveJurisdiction())

describe("website apply, on a process that has not loaded the lender's jurisdiction yet", () => {
  it("loads it before anything else, so the ID check is the lender's own", async () => {
    await call("12345678")
    expect(mocks.order[0]).toBe("ensure")
  })

  it("refuses a South African ID under a Kenyan lender with the Kenyan message", async () => {
    const res = await call("8001015009087")
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Please enter a valid Kenyan national ID number.")
  })

  it("accepts a Kenyan ID under a Kenyan lender (it gets past the ID check, to the tenant lookup)", async () => {
    const res = await call("12345678")
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe("Service unavailable")
  })

  it("still judges a South African lender's ID by the South African rule", async () => {
    mocks.instance = "ZA"
    const res = await call("12345678")
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Please enter a valid 13-digit South African ID number.")
  })
})

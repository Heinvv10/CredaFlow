import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { runCollectionsCron } = vi.hoisted(() => ({ runCollectionsCron: vi.fn() }))
vi.mock("@/lib/collections-engine/cron", () => ({ runCollectionsCron }))

import { GET as submit } from "./collections-submit/route"
import { GET as results } from "./collections-results/route"

// The routes' own contract: secret first, non-2xx on any failure. What a run
// does is proven against Postgres in
// lib/collections-engine/collections-engine.integration.test.ts.

const SECRET = "unit-test-cron-secret"
const request = (secret = SECRET) => new NextRequest("http://localhost/api/cron/x", { headers: { "x-cron-secret": secret } })

describe.each([
  ["collections-submit", submit, "SUBMIT"],
  ["collections-results", results, "RESULTS"],
] as const)("GET /api/cron/%s", (_name, route, kind) => {
  const saved = process.env.CRON_SECRET
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET
    runCollectionsCron.mockReset().mockResolvedValue({ ok: true, kind, perTenant: [] })
  })
  afterEach(() => {
    process.env.CRON_SECRET = saved
  })

  it("refuses a wrong secret without running anything", async () => {
    const response = await route(request("not-the-cron-secret-!!"))
    expect(response.status).toBe(401)
    expect(runCollectionsCron).not.toHaveBeenCalled()
  })

  it("runs its side of the engine", async () => {
    const response = await route(request())
    expect(response.status).toBe(200)
    expect(runCollectionsCron).toHaveBeenCalledWith(kind, expect.any(Date))
  })

  it("answers 503, not a hardcoded ok, when any tenant failed", async () => {
    runCollectionsCron.mockResolvedValue({ ok: false, kind, perTenant: [{ tenantId: "t1", outcome: "ERROR", error: "boom" }] })
    const response = await route(request())
    expect(response.status).toBe(503)
  })
})

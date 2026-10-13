import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { findUniqueMock } = vi.hoisted(() => ({ findUniqueMock: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { tenantConfig: { findUnique: findUniqueMock } } }))

import { getCreditReport } from "./transunion"

const opts = { tenantId: "tenant-1", idNumber: "9001015800086", firstName: "Synthetic", lastName: "Applicant" }

function respondWith(report: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/auth/token")
        ? new Response(JSON.stringify({ access_token: "synthetic-token", expires_in: 3600 }))
        : new Response(JSON.stringify(report)),
    ),
  )
}

describe("getCreditReport live path", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("TRANSUNION_DRY_RUN", "false")
    findUniqueMock.mockResolvedValue({ transunionKey: "synthetic-id:synthetic-secret" })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it("parses a response that carries a numeric score", async () => {
    respondWith({ creditScore: 612, riskGrade: "B" })
    await expect(getCreditReport(opts)).resolves.toMatchObject({ ok: true, score: 612, riskGrade: "B" })
  })

  it("fails closed on a response with no recognisable score", async () => {
    respondWith({ somethingElse: true })
    const r = await getCreditReport(opts)
    expect(r.ok).toBe(false)
    expect(r.score).toBeUndefined()
    expect(r.error).toMatch(/unrecognised response/i)
  })
})

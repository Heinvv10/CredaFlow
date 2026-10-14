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

  it("never spends one tenant's access token on another tenant's enquiry", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/token")) {
        const clientId = new URLSearchParams(String(init?.body)).get("client_id")
        return new Response(JSON.stringify({ access_token: `token-for-${clientId}`, expires_in: 3600 }))
      }
      return new Response(JSON.stringify({ creditScore: 600 }))
    })
    vi.stubGlobal("fetch", fetchMock)
    findUniqueMock.mockImplementation(async ({ where }: { where: { tenantId: string } }) =>
      ({ transunionKey: `client-${where.tenantId}:synthetic-secret` }))

    await getCreditReport({ ...opts, tenantId: "tenant-a" })
    await getCreditReport({ ...opts, tenantId: "tenant-b" })

    const bearers = fetchMock.mock.calls
      .filter(([url]) => !String(url).endsWith("/auth/token"))
      .map(([, init]) => (init?.headers as Record<string, string>).Authorization)
    expect(bearers).toEqual(["Bearer token-for-client-tenant-a", "Bearer token-for-client-tenant-b"])
  })

  it("fails closed on a response with no recognisable score", async () => {
    respondWith({ somethingElse: true })
    const r = await getCreditReport(opts)
    expect(r.ok).toBe(false)
    expect(r.score).toBeUndefined()
    expect(r.error).toMatch(/unrecognised response/i)
  })
})

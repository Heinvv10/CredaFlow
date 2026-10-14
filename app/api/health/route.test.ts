import { afterEach, describe, expect, it, vi } from "vitest"

const { queryRaw } = vi.hoisted(() => ({
  queryRaw: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: queryRaw,
  },
}))
const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  queryRaw.mockReset()
})

async function getHealth() {
  const { GET } = await import("./route")
  const response = await GET()
  return {
    response,
    body: await response.json(),
  }
}

describe("/api/health", () => {
  it("returns deploy marker metadata when the database is healthy", async () => {
    vi.stubEnv("GIT_SHA", "bda437dcf6baaa139ce472483d1f0110e4854e30")
    vi.stubEnv("BUILD_TIME", "2026-05-12T10:30:00.000Z")
    queryRaw.mockResolvedValue([{ "?column?": 1 }])

    const { response, body } = await getHealth()

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(body).toMatchObject({
      status: "ok",
      commit: "bda437dcf6baaa139ce472483d1f0110e4854e30",
      builtAt: "2026-05-12T10:30:00.000Z",
    })
    expect(new Date(body.checkedAt).toString()).not.toBe("Invalid Date")
  })

  // Row-level security binds no superuser or BYPASSRLS role. The probe stays
  // public and says nothing about it; an operator session gets the detail.
  describe("when the runtime database role bypasses row-level security", () => {
    it.each([
      ["a superuser", { su: true, bypass: false }],
      ["a BYPASSRLS role", { su: false, bypass: true }],
    ])("warns an operator session when the role is %s", async (_label, role) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
      queryRaw.mockResolvedValue([role])
      authMock.mockResolvedValue({ user: { id: "op1", role: "OPERATOR_ADMIN", tenantId: null } })
      const { response, body } = await getHealth()
      expect(response.status).toBe(200)
      expect(body.warnings).toEqual([expect.stringContaining("row-level security is not enforced")])
      warn.mockRestore()
    })

    it("tells a public probe and lender staff nothing", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
      queryRaw.mockResolvedValue([{ su: true, bypass: false }])
      for (const session of [null, { user: { id: "u1", role: "SUPER_ADMIN", tenantId: "t1" } }]) {
        authMock.mockResolvedValue(session)
        const { body } = await getHealth()
        expect(body).not.toHaveProperty("warnings")
      }
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("row-level security is not enforced"))
      warn.mockRestore()
    })

    it("says nothing when the role is bound by row-level security", async () => {
      queryRaw.mockResolvedValue([{ su: false, bypass: false }])
      authMock.mockResolvedValue({ user: { id: "op1", role: "OPERATOR_ADMIN", tenantId: null } })
      const { body } = await getHealth()
      expect(body).not.toHaveProperty("warnings")
    })
  })
})

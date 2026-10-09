import { afterEach, describe, expect, it, vi } from "vitest"

const { queryRaw } = vi.hoisted(() => ({
  queryRaw: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: queryRaw,
  },
}))

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
})

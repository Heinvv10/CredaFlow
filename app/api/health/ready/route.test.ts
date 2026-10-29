import { beforeEach, describe, expect, it, vi } from "vitest"

const { probeDatabase } = vi.hoisted(() => ({ probeDatabase: vi.fn() }))
vi.mock("@/lib/ops/health-checks", () => ({ probeDatabase }))

import { GET } from "./route"

beforeEach(() => probeDatabase.mockReset())

describe("/api/health/ready", () => {
  it("is ready (200) when the database answers", async () => {
    probeDatabase.mockResolvedValue({ state: "ok", latencyMs: 3 })
    const response = await GET()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ready" })
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("is not ready (503) when the database does not answer, so the pod leaves the Service", async () => {
    probeDatabase.mockResolvedValue({ state: "error", latencyMs: 5000 })
    const response = await GET()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: "not_ready" })
  })
})

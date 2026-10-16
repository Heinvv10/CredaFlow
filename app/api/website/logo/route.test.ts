import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ tenant: vi.fn(), logo: vi.fn() }))
vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: h.tenant }))
vi.mock("@/lib/config/lender-logo", () => ({ getLenderLogo: h.logo }))

import { GET } from "./route"

const req = () => new NextRequest("https://fairscore.credaflow.com/api/website/logo")

beforeEach(() => vi.clearAllMocks())

describe("GET /api/website/logo", () => {
  it("serves the request host's tenant logo as an inert PNG", async () => {
    h.tenant.mockResolvedValue({ id: "t1" })
    h.logo.mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(h.logo).toHaveBeenCalledWith("t1")
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("content-security-policy")).toContain("sandbox")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  })

  it("404s with no tenant or no logo", async () => {
    h.tenant.mockResolvedValue(null)
    expect((await GET(req())).status).toBe(404)
    h.tenant.mockResolvedValue({ id: "t1" })
    h.logo.mockResolvedValue(undefined)
    expect((await GET(req())).status).toBe(404)
  })
})

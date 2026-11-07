import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const getDocMock = vi.fn()
const pricingMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (...args: unknown[]) => requireApiRoleMock(...args) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/observability/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/config/website-imagery", () => ({ getWebsiteImageryDocument: (...args: unknown[]) => getDocMock(...args) }))
vi.mock("@/lib/public-loan-products-server", () => ({ getLivePricingServer: (...args: unknown[]) => pricingMock(...args) }))

import { GET } from "./route"

const get = () => GET(new NextRequest("https://app.example.test/api/settings/website-imagery"))

describe("GET /api/settings/website-imagery", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "admin-1", email: "a@b.example" } })
    pricingMock.mockResolvedValue({})
  })

  it("requires ADMIN and reads the caller's own tenant", async () => {
    getDocMock.mockResolvedValue({ hero: { alt: "x" } })
    const res = await get()
    expect(requireApiRoleMock).toHaveBeenCalledWith("ADMIN")
    expect(getDocMock).toHaveBeenCalledWith("tenant-1")
    expect(await res.json()).toEqual({ imagery: { hero: { alt: "x" } }, offeredProducts: [] })
  })

  it("names the loan products the lender offers, in catalogue order: the home page has a card for each and no other", async () => {
    getDocMock.mockResolvedValue(null)
    pricingMock.mockResolvedValue({ personal: {}, "short-term": {} })
    expect(await (await get()).json()).toEqual({ imagery: {}, offeredProducts: ["short-term", "personal"] })
    expect(pricingMock).toHaveBeenCalledWith("tenant-1")
  })

  it("answers an empty document when none is set, and refuses a non-admin", async () => {
    getDocMock.mockResolvedValue(null)
    expect(await (await get()).json()).toEqual({ imagery: {}, offeredProducts: [] })
    requireApiRoleMock.mockResolvedValue({ error: new Response("{}", { status: 403 }) })
    expect((await get()).status).toBe(403)
    expect(getDocMock).toHaveBeenCalledTimes(1)
  })
})

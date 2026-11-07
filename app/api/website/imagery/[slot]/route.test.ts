import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const getTenantMock = vi.fn()
const readMock = vi.fn()

vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: (...args: unknown[]) => getTenantMock(...args) }))
vi.mock("@/lib/config/website-imagery", () => ({ readWebsiteImage: (...args: unknown[]) => readMock(...args) }))

import { GET } from "./route"

const HASH = "ab12cd34ef56" + "0".repeat(52)
const request = (slot: string, query = "") => [new NextRequest(`https://acme.example.test/api/website/imagery/${slot}${query}`), { params: Promise.resolve({ slot }) }] as const

describe("GET /api/website/imagery/[slot]", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    getTenantMock.mockResolvedValue({ id: "tenant-1" })
    readMock.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mime: "image/webp", sha256: HASH })
  })

  it("serves the host's tenant's 1920 px copy by default, with its own type and no-sniff, sandboxed headers", async () => {
    const res = await GET(...request("hero"))
    expect(res.status).toBe(200)
    expect(readMock).toHaveBeenCalledWith("tenant-1", "hero", { width: 1920 })
    expect(res.headers.get("content-type")).toBe("image/webp")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox")
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it("serves the 800 px copy on request, and 404s any other width", async () => {
    expect((await GET(...request("hero", "?w=800"))).status).toBe(200)
    expect(readMock).toHaveBeenLastCalledWith("tenant-1", "hero", { width: 800 })
    for (const w of ["0", "1000", "abc", "", "99999"]) expect((await GET(...request("hero", `?w=${w}`))).status).toBe(404)
  })

  it("caches for a day whatever the version asked for, so a removed photo drops out of browsers and CDNs by tomorrow", async () => {
    for (const query of ["?v=ab12cd34ef56", "?v=000000000000", ""]) {
      expect((await GET(...request("hero", query))).headers.get("cache-control")).toBe("public, max-age=86400")
    }
  })

  it("answers 404 for an unknown slot without looking up a tenant, for an empty slot, and for an unknown host", async () => {
    expect((await GET(...request("banner"))).status).toBe(404)
    expect((await GET(...request("../hero"))).status).toBe(404)
    expect(getTenantMock).not.toHaveBeenCalled()
    readMock.mockResolvedValue(undefined)
    expect((await GET(...request("community"))).status).toBe(404)
    getTenantMock.mockResolvedValue(null)
    expect((await GET(...request("hero"))).status).toBe(404)
    expect(readMock).toHaveBeenCalledTimes(1)
  })
})

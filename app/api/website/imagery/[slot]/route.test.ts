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
    readMock.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg", sha256: HASH })
  })

  it("serves the host's tenant's image with its own type and no-sniff, sandboxed headers", async () => {
    const res = await GET(...request("hero"))
    expect(res.status).toBe(200)
    expect(readMock).toHaveBeenCalledWith("tenant-1", "hero")
    expect(res.headers.get("content-type")).toBe("image/jpeg")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox")
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it("caches for good only a request that names the current version", async () => {
    expect((await GET(...request("hero", "?v=ab12cd34ef56"))).headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect((await GET(...request("hero", "?v=000000000000"))).headers.get("cache-control")).toBe("public, max-age=300")
    expect((await GET(...request("hero"))).headers.get("cache-control")).toBe("public, max-age=300")
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

import { describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { loanProduct: { findMany: (args: unknown) => findMany(args) } } }))
vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: vi.fn(async () => ({ id: "tenant-1" })) }))

import { GET } from "./route"

describe("GET /api/website/loan-pricing (Fair Score E4)", () => {
  it("reads only active consumer products: an asset-finance product never reaches the public calculator", async () => {
    findMany.mockResolvedValue([])
    const res = await GET(new NextRequest("http://localhost/api/website/loan-pricing"))
    expect(res.status).toBe(200)
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1", active: true, productType: { not: "ASSET_FINANCE" } },
    }))
  })
})

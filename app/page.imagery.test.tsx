import type { ReactElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"

// The home page's wiring: the request tenant's id reaches the imagery read, and what it
// returns (or nothing, when the read fails) reaches HomePage. The shell and HomePage
// are stand-ins; the imagery module is the real one unless a test replaces it.
const identityMock = vi.fn()
const viewMock = vi.hoisted(() => vi.fn())
const findUnique = vi.hoisted(() => vi.fn())

vi.mock("@/lib/website/identity", () => ({ getWebsiteIdentity: () => identityMock() }))
vi.mock("@/lib/public-loan-products-server", () => ({ getTenantPublicProductsServer: async () => [] }))
vi.mock("@/lib/i18n/server", () => ({ getLocale: async () => "en" }))
vi.mock("@/lib/website/site-jurisdiction.server", () => ({ getSiteJurisdiction: async () => ({ nca: true }) }))
vi.mock("@/lib/tenant", () => ({ getResolvedTenantId: async () => "tenant-77" }))
vi.mock("@/lib/prisma", () => ({ prisma: { tenantConfig: { findUnique } } }))
vi.mock("@/lib/observability/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock("@/components/website/WebsiteShell", () => ({ WebsiteShell: () => null }))
vi.mock("@/components/website/HomePage", () => ({ HomePage: () => null }))
vi.mock("@/lib/config/website-imagery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config/website-imagery")>()
  viewMock.mockImplementation(actual.getWebsiteImageryView)
  return { ...actual, getWebsiteImageryView: viewMock }
})

import Home from "./page"

/** The props HomePage receives, found in the element the page returns. */
async function homePageProps(): Promise<Record<string, unknown>> {
  const shell = (await Home()) as ReactElement<{ children: ReactElement<Record<string, unknown>> }>
  return shell.props.children.props
}

describe("app/page.tsx imagery wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    identityMock.mockResolvedValue(ACME_LENDER)
    findUnique.mockResolvedValue({ websiteImagery: null })
  })

  it("reads the images of the request's tenant and hands the result to HomePage", async () => {
    const view = { hero: { src: "/h", srcSet: "/h 1w", alt: "A hero", width: 1, height: 1 }, products: {} }
    viewMock.mockResolvedValueOnce(view)
    expect((await homePageProps()).imagery).toBe(view)
    expect(viewMock).toHaveBeenCalledWith("tenant-77")
  })

  it("renders HomePage with no imagery when the tenant has none", async () => {
    expect((await homePageProps()).imagery).toBeNull()
    expect(findUnique).toHaveBeenCalledWith({ where: { tenantId: "tenant-77" }, select: { websiteImagery: true } })
  })

  it("renders HomePage with no imagery, not an error page, when the read fails", async () => {
    findUnique.mockRejectedValue(new Error("db down"))
    expect((await homePageProps()).imagery).toBeNull()
  })

  it("does not read images when the lender has no identity (the not-configured state)", async () => {
    identityMock.mockResolvedValue(null)
    const shell = (await Home()) as ReactElement<{ children: unknown }>
    expect(shell.props.children).toBeFalsy()
    expect(viewMock).not.toHaveBeenCalled()
  })
})

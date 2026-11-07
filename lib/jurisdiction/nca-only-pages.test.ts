import { afterEach, describe, expect, it, vi } from "vitest"

class NotFound extends Error {}
vi.mock("next/navigation", () => ({ notFound: () => { throw new NotFound("NEXT_NOT_FOUND") }, redirect: vi.fn() }))
vi.mock("@/lib/auth-guards", () => ({
  PERMISSIONS: new Proxy({}, { get: (_t, name) => String(name) }),
  requireMinRole: vi.fn(async () => ({ role: "ADMIN", id: "u1" })),
  hasMinRole: () => true,
  canDo: () => true,
}))
// Past the guard a page reaches for the database; a ZA run is allowed to fail there, only not with notFound().
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: () => { throw new Error("database reached") } }) }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: vi.fn(async () => { throw new Error("tenant reached") }) }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

import type { NcaOnlySurfaces } from "./nca-only-registry"
import { resetActiveJurisdiction, setActiveJurisdiction } from "./active"

afterEach(() => resetActiveJurisdiction())

const PAGES: Array<[string, () => Promise<{ default: (props: never) => Promise<unknown> }>]> = [
  ["settings/repo-rate", () => import("@/app/(dashboard)/settings/repo-rate/page")],
  ["compliance/ncr-return", () => import("@/app/(dashboard)/compliance/ncr-return/page")],
  ["compliance/fsca-return", () => import("@/app/(dashboard)/compliance/fsca-return/page")],
  ["compliance/tcf", () => import("@/app/(dashboard)/compliance/tcf/page")],
  ["compliance/fic", () => import("@/app/(dashboard)/compliance/fic/page")],
  ["portal/insurance", () => import("@/app/(portal)/portal/insurance/page")],
  ["portal/insurance/[id]", () => import("@/app/(portal)/portal/insurance/[id]/page")],
  ["site/products/insurance", () => import("@/app/(website)/site/products/insurance/page")],
  ["site/products/insurance/quotes", () => import("@/app/(website)/site/products/insurance/quotes/page")],
  ["site/regulatory-information", () => import("@/app/(website)/site/regulatory-information/page")],
]
const props = { searchParams: Promise.resolve({}), params: Promise.resolve({ id: "x" }) } as never

describe.each(PAGES)("%s page", (_name, load) => {
  it("is not found for a lender outside the NCA's jurisdiction", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const { default: Page } = await load()
    await expect(Page(props)).rejects.toBeInstanceOf(NotFound)
  })

  it("is served to a ZA lender (it gets past the guard)", async () => {
    const { default: Page } = await load()
    const outcome = await Page(props).then(() => null, (e: unknown) => e)
    expect(outcome).not.toBeInstanceOf(NotFound)
  })
})

// A layout wraps its page, so a page gated alone still lets the layout print its own markup and schema around the 404.
const LAYOUTS: Array<[string, () => Promise<{ default: (props: { children: null }) => Promise<unknown> }>]> = [
  ["site/regulatory-information", () => import("@/app/(website)/site/regulatory-information/layout")],
]

describe.each(LAYOUTS)("%s layout", (_name, load) => {
  it.each([["LS", "LSL"], ["KE", "KES"]] as const)("is not found for a %s lender", async (jurisdiction, currency) => {
    setActiveJurisdiction({ jurisdiction, currency })
    const { default: Layout } = await load()
    await expect(Layout({ children: null })).rejects.toBeInstanceOf(NotFound)
  })

  it("is served to a ZA lender (it gets past the guard)", async () => {
    const { default: Layout } = await load()
    const outcome = await Layout({ children: null }).then(() => null, (e: unknown) => e)
    expect(outcome).not.toBeInstanceOf(NotFound)
  })
})

describe("page coverage", () => {
  it("every layout in the NCA-only registry is exercised above", () => {
    const registry = import.meta.glob<{ default: NcaOnlySurfaces }>("../registry/nca-only/*.ts", { eager: true })
    const registered = Object.values(registry).flatMap((m) => Object.keys(m.default)).filter((s) => s.endsWith("layout.tsx"))
    const missing = registered.filter((layout) => !LAYOUTS.some(([name]) => layout.includes(`/${name}/layout.tsx`)))
    expect(missing).toEqual([])
  })

  it("every page in the NCA-only registry is exercised above", () => {
    const registry = import.meta.glob<{ default: NcaOnlySurfaces }>("../registry/nca-only/*.ts", { eager: true })
    const registered = Object.values(registry).flatMap((m) => Object.keys(m.default)).filter((s) => s.endsWith("page.tsx"))
    const tested = PAGES.map(([name]) => name)
    const missing = registered.filter((page) => !tested.some((name) => page.includes(`/${name}/page.tsx`)))
    expect(missing).toEqual([])
  })
})

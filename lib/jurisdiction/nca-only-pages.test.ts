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
]
const props = { searchParams: Promise.resolve({}) } as never

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

describe("page coverage", () => {
  it("every page in the NCA-only registry is exercised above", () => {
    const registry = import.meta.glob<{ default: NcaOnlySurfaces }>("../registry/nca-only/*.ts", { eager: true })
    const registered = Object.values(registry).flatMap((m) => Object.keys(m.default)).filter((s) => s.endsWith("page.tsx"))
    const tested = PAGES.map(([name]) => name)
    const missing = registered.filter((page) => !tested.some((name) => page.includes(`/${name}/page.tsx`)))
    expect(missing).toEqual([])
  })
})

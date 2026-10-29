import { afterEach, describe, expect, it, vi } from "vitest"

class NotFound extends Error {}
vi.mock("next/navigation", () => ({ notFound: () => { throw new NotFound("NEXT_NOT_FOUND") }, redirect: vi.fn() }))
vi.mock("@/lib/auth-guards", () => ({
  requireMinRole: vi.fn(async () => ({ role: "ADMIN", id: "u1" })),
  hasMinRole: () => true,
  canDo: () => true,
}))
// Past the guard a page reaches for the database; a ZA run is allowed to fail there, only not with notFound().
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: () => { throw new Error("database reached") } }) }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: vi.fn(async () => { throw new Error("tenant reached") }) }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

import { resetActiveJurisdiction, setActiveJurisdiction } from "./active"

afterEach(() => resetActiveJurisdiction())

const PAGES: Array<[string, () => Promise<{ default: (props: never) => Promise<unknown> }>]> = [
  ["settings/repo-rate", () => import("@/app/(dashboard)/settings/repo-rate/page")],
  ["compliance/ncr-return", () => import("@/app/(dashboard)/compliance/ncr-return/page")],
  ["compliance/fsca-return", () => import("@/app/(dashboard)/compliance/fsca-return/page")],
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

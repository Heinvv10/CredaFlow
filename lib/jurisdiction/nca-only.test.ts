import { afterEach, describe, expect, it, vi } from "vitest"

const findUnique = vi.fn()
vi.mock("@/lib/prisma", () => ({ prisma: { instanceJurisdiction: { findUnique: (...a: unknown[]) => findUnique(...a) } } }))
import { resetActiveJurisdiction, setActiveJurisdiction } from "./active"
import { resetEnsuredJurisdiction } from "./load.server"
import { ncaOnlyRefusal } from "./nca-only"
import { itemEnabled } from "@/components/app-shell/AppSidebar"
import { staffNavigation } from "@/lib/navigation"

afterEach(() => { resetActiveJurisdiction(); resetEnsuredJurisdiction(); findUnique.mockReset() })

describe("ncaOnlyRefusal", () => {
  it("lets a ZA lender through", async () => {
    expect(await ncaOnlyRefusal("The NCR return")).toBeNull()
  })

  it("answers 404 for an LS lender", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const refusal = await ncaOnlyRefusal("The NCR return")
    expect(refusal?.status).toBe(404)
    expect(await refusal?.json()).toEqual({ error: "The NCR return does not apply to this lender." })
  })
})

describe("a cold process", () => {
  it("loads the instance jurisdiction before it decides, so an LS instance is never let through on the ZA default", async () => {
    findUnique.mockResolvedValue({ id: 1, jurisdiction: "LS", currency: "LSL" })
    expect((await ncaOnlyRefusal("The NCR return"))?.status).toBe(404)
  })

  it("and a ZA instance is let through", async () => {
    findUnique.mockResolvedValue({ id: 1, jurisdiction: "ZA", currency: "ZAR" })
    expect(await ncaOnlyRefusal("The NCR return")).toBeNull()
  })
})

describe("staff navigation", () => {
  const ncr = staffNavigation.flatMap((g) => g.items).find((i) => i.href === "/compliance/ncr-return")!

  it("shows the NCR return to a ZA lender", () => {
    expect(itemEnabled(ncr, "ADMIN")).toBe(true)
  })

  it("hides it from an LS lender but keeps the other compliance items", () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    expect(itemEnabled(ncr, "ADMIN")).toBe(false)
    const complaints = staffNavigation.flatMap((g) => g.items).find((i) => i.href === "/compliance/complaints")!
    expect(itemEnabled(complaints, "ADMIN")).toBe(true)
  })

  it("hides the repo-rate setting (the NCA cap input) from an LS lender", () => {
    const repo = staffNavigation.flatMap((g) => g.items).find((i) => i.href === "/settings/repo-rate")!
    expect(itemEnabled(repo, "ADMIN")).toBe(true)
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    expect(itemEnabled(repo, "ADMIN")).toBe(false)
  })
})

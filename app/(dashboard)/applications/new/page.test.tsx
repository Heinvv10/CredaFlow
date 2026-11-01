import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
const { role, reads, offer, draft } = vi.hoisted(() => ({ role: { value: "READONLY" }, reads: vi.fn(), offer: vi.fn(), draft: vi.fn() }))
vi.mock("@/lib/auth-guards", async () => ({ hasMinRole: (await import("@/lib/permissions")).hasMinRole, requireMinRole: async () => ({ role: role.value }) }))
vi.mock("@/lib/prisma", () => ({ prisma: { client: { findMany: reads }, loanProduct: { findMany: reads }, insuranceProduct: { findFirst: offer }, loanApplication: { findFirst: draft } } }))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: async () => "synthetic" }))
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { ApplicationWizard } from "@/components/applications/wizard/ApplicationWizard"
import NewApplicationPage from "./page"

type Element = { type?: unknown; props?: { children?: unknown; ncaDeclarations?: boolean; creditLifeOffer?: { productId: string } | null } }
/** The wizard element in the page's tree, without rendering a client component on the server. */
function wizardProps(node: unknown): Element["props"] | null {
  const element = node as Element | null
  if (!element || typeof element !== "object") return null
  if (element.type === ApplicationWizard) return element.props
  const children = element.props?.children
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = wizardProps(child)
    if (found) return found
  }
  return null
}
describe("application write affordance", () => {
  it("explains the READONLY refusal without loading capture data or a wizard", async () => {
    const html = renderToStaticMarkup(await NewApplicationPage({ searchParams: Promise.resolve({}) }))
    expect(html).toContain("read-only")
    expect(html).not.toContain("<form")
    expect(reads).not.toHaveBeenCalled()
  })

  describe("with a credit-life product row configured", () => {
    const row = { id: "cl-1", name: "Synthetic Cover", insurerId: "ins-1", insurer: { name: "Synthetic Insurer" } }
    const draftRow = { id: "d1", clientId: "c1", productId: "p1", appliedAmount: 500_000, appliedTermDays: 30, purpose: null, loanPurposeCategory: null, poNumber: null, poBuyerName: null, poDocumentId: null }
    const page = async (searchParams: { id?: string } = {}) => {
      role.value = "CREDIT_OFFICER"
      reads.mockResolvedValue([])
      offer.mockReset().mockResolvedValue(row)
      return wizardProps(await NewApplicationPage({ searchParams: Promise.resolve(searchParams) }))
    }
    afterEach(() => resetActiveJurisdiction())

    it("presents the offer and the NCA declarations on a South African instance", async () => {
      expect(await page()).toMatchObject({ creditLifeOffer: { productId: "cl-1" }, ncaDeclarations: true })
    })

    it("presents neither on a Lesotho instance: the wizard would post an offer the server has no record of, and answer 409", async () => {
      setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
      expect(await page()).toMatchObject({ creditLifeOffer: null, ncaDeclarations: false })
      expect(offer).not.toHaveBeenCalled()
    })

    it("a resumed draft keeps the regime it was stamped with: an NCA_PASQ draft on a Lesotho instance is still offered cover", async () => {
      setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
      draft.mockResolvedValue({ ...draftRow, disclosureRegime: "NCA_PASQ" })
      expect(await page({ id: "d1" })).toMatchObject({ creditLifeOffer: { productId: "cl-1" }, ncaDeclarations: true })
    })
  })
})

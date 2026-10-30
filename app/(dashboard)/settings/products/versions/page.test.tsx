import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ role: "LOAN_ADMIN", redirected: null as string | null }))
vi.mock("next/navigation", () => ({ redirect: (to: string) => { state.redirected = to; throw new Error(`redirect:${to}`) } }))
vi.mock("@/lib/auth-guards", () => ({ requireMinRole: vi.fn(async () => ({ id: "u1", role: state.role })) }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: vi.fn(async () => "t-1") }))
vi.mock("@/lib/product-engine/overview", () => ({ loadProductEngineOverview: vi.fn(async () => ({ today: "2027-03-01", nca: false, products: [], versions: [], rules: [], requests: [] })) }))
vi.mock("@/components/layout/Header", () => ({ Header: ({ title }: { title: string }) => `[header:${title}]` }))
vi.mock("@/components/settings/product-versions/ProductVersionsWorkspace", () => ({ ProductVersionsWorkspace: ({ overview }: { overview: { canManage: boolean; canApprove: boolean } }) => `[workspace manage=${overview.canManage} approve=${overview.canApprove}]` }))

import ProductVersionsPage from "./page"

describe("product versions page", () => {
  beforeEach(() => { state.role = "LOAN_ADMIN"; state.redirected = null })

  it("a loan administrator drafts but does not approve", async () => {
    const html = renderToStaticMarkup(await ProductVersionsPage())
    expect(html).toContain("[workspace manage=true approve=false]")
  })

  it("an administrator approves", async () => {
    state.role = "ADMIN"
    expect(renderToStaticMarkup(await ProductVersionsPage())).toContain("approve=true")
  })

  it("is not for someone below a loan administrator", async () => {
    state.role = "CREDIT_OFFICER"
    await expect(ProductVersionsPage()).rejects.toThrow("redirect:/settings")
  })
})

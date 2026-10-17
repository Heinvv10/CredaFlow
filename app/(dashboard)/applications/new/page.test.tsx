import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
const { role, reads } = vi.hoisted(() => ({ role: { value: "READONLY" }, reads: vi.fn() }))
vi.mock("@/lib/auth-guards", async () => ({ hasMinRole: (await import("@/lib/permissions")).hasMinRole, requireMinRole: async () => ({ role: role.value }) }))
vi.mock("@/lib/prisma", () => ({ prisma: { client: { findMany: reads }, loanProduct: { findMany: reads } } }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: async () => "synthetic" }))
import NewApplicationPage from "./page"
describe("application write affordance", () => {
  it("explains the READONLY refusal without loading capture data or a wizard", async () => {
    const html = renderToStaticMarkup(await NewApplicationPage({ searchParams: Promise.resolve({}) }))
    expect(html).toContain("read-only")
    expect(html).not.toContain("<form")
    expect(reads).not.toHaveBeenCalled()
  })
})

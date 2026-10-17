import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
vi.mock("@/lib/auth-guards", async () => ({ hasMinRole: (await import("@/lib/permissions")).hasMinRole, requireMinRole: async () => ({ role: "READONLY" }) }))
vi.mock("@/components/clients/wizard/ClientWizard", () => ({ ClientWizard: () => <form data-synthetic-wizard /> }))
import NewClientPage from "./page"
describe("client registration write access", () => {
  it("shows READONLY an explanation and no capture wizard", async () => {
    const html = renderToStaticMarkup(await NewClientPage())
    expect(html).toContain("read-only")
    expect(html).not.toContain("<form")
  })
})

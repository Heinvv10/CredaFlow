import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ session: null as null | { user: Record<string, unknown> }, quote: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }) }))
vi.mock("@/lib/non-nca-documents/pre-submission", () => ({ issueIndicativeKeyFactsForDraft: h.quote }))

import { TemplateUnavailableError } from "@/lib/documents/render"
import { POST } from "./route"

const staff = (role: string) => ({ user: { id: "u1", email: "o@x.invalid", role, tenantId: "t1" } })
const call = () => POST(new NextRequest("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ id: "a1" }) })

describe("POST the statement of a staff draft (real role guard)", () => {
  beforeEach(() => { h.quote.mockReset(); h.quote.mockResolvedValue({ ok: true, sha256: "a" }) })

  it.each([[null, 401], [staff("READONLY"), 403], [staff("CLIENT"), 403]])("refuses %j", async (session, status) => {
    h.session = session as typeof h.session
    expect((await call()).status).toBe(status)
    expect(h.quote).not.toHaveBeenCalled()
  })

  it("issues for a credit officer, on the draft and in their name", async () => {
    h.session = staff("CREDIT_OFFICER")
    expect((await call()).status).toBe(201)
    expect(h.quote).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", applicationId: "a1", staff: { id: "u1", email: "o@x.invalid" } }))
  })

  it("passes the regime and status refusals through, and names an unpublished template", async () => {
    h.session = staff("CREDIT_OFFICER")
    h.quote.mockResolvedValue({ ok: false, status: 400, error: "This application has no key facts statement" })
    expect((await call()).status).toBe(400)
    h.quote.mockRejectedValue(new TemplateUnavailableError("non_nca_key_facts"))
    expect((await call()).status).toBe(409)
  })
})

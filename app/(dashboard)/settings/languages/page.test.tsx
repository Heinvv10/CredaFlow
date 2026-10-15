import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { catalogueHash } from "@/lib/i18n/catalogue-hash"

// The settings page flags a language whose text was edited after its review:
// it is not served, and the page asks for a new acknowledgement.

const h = vi.hoisted(() => ({ config: vi.fn() }))
vi.mock("@/lib/auth-guards", () => ({ requireMinRole: async () => ({ id: "u1", role: "SUPER_ADMIN" }) }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: async () => "t1" }))
vi.mock("@/lib/prisma", () => ({ prisma: { tenantConfig: { findUnique: (a: unknown) => h.config(a) } } }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: vi.fn() }))
vi.mock("@/components/layout/Header", () => ({ Header: ({ title }: { title: string }) => <h1>{title}</h1> }))

import LanguageSettingsPage from "./page"

const review = (hash: string) => ({ reviewer: "N. Reviewer", acknowledgedAt: "2026-10-01T08:00:00.000Z", acknowledgedById: "u0", acknowledgedByEmail: "sa@lender.example", catalogueHash: hash })

const render = async () => renderToStaticMarkup(await LanguageSettingsPage()).replace(/<!-- -->/g, "")

describe("settings / borrower languages", () => {
  it("marks a language changed since its review and asks for a new acknowledgement", async () => {
    h.config.mockResolvedValue({ enabledLanguages: ["en", "af", "zu"], languageReviews: { af: review("an-older-af-text"), zu: review(catalogueHash("zu")) } })
    const html = await render()
    expect(html).toContain("Changed since review: the Afrikaans text was edited")
    expect(html).not.toContain("Changed since review: the isiZulu text")
    expect(html).toContain("Native-speaker reviewer for Afrikaans")
    expect(html).not.toContain("Native-speaker reviewer for isiZulu")
  })

  it("shows no warning when every review matches the current text", async () => {
    h.config.mockResolvedValue({ enabledLanguages: ["en", "af"], languageReviews: { af: review(catalogueHash("af")) } })
    const html = await render()
    expect(html).toContain("Reviewed by N. Reviewer")
    expect(html).not.toContain("Changed since review")
  })
})

import { describe, expect, it, vi } from "vitest"

const tenantConfigFindUnique = vi.hoisted(() => vi.fn())
vi.mock("@/lib/prisma", () => ({ prisma: { tenantConfig: { findUnique: tenantConfigFindUnique } } }))

import { WA_TEMPLATES } from "@/lib/whatsapp"
import { parseLenderIdentity } from "@/lib/config/identity"
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"
import { applicationApprovedEmail, paymentReceivedEmail } from "@/lib/email/templates/portal"
import { overdueHtml } from "@/lib/email/templates/loan-events"
import { clientCommsLocale, localizedWaTemplates, pickTemplateForLocale, resolveCommsLocale } from "./comms"

describe("resolveCommsLocale", () => {
  it("uses the preference only when the tenant has it enabled", () => {
    expect(resolveCommsLocale("zu", ["en", "zu"])).toBe("zu")
    expect(resolveCommsLocale("zu", ["en", "af"])).toBe("en")
    expect(resolveCommsLocale(null, ["en", "af"])).toBe("en")
    expect(resolveCommsLocale("fr", ["en", "af"])).toBe("en")
  })
})

describe("clientCommsLocale", () => {
  it("reads the tenant only for a non-English preference", async () => {
    tenantConfigFindUnique.mockResolvedValue({ enabledLanguages: ["en", "xh"] })
    expect(await clientCommsLocale("t1", "xh")).toBe("xh")
    expect(tenantConfigFindUnique).toHaveBeenCalledWith({ where: { tenantId: "t1" }, select: { enabledLanguages: true } })
    tenantConfigFindUnique.mockClear()
    expect(await clientCommsLocale("t1", "en")).toBe("en")
    expect(await clientCommsLocale("t1", undefined)).toBe("en")
    expect(tenantConfigFindUnique).not.toHaveBeenCalled()
  })

  it("is English for a tenant without a config row", async () => {
    tenantConfigFindUnique.mockResolvedValue(null)
    expect(await clientCommsLocale("t1", "af")).toBe("en")
  })
})

describe("pickTemplateForLocale", () => {
  const base = { id: "base", language: "en", active: true }
  it("takes the variant only when it is active and its language agrees", () => {
    const af = { id: "af", language: "af", active: true }
    expect(pickTemplateForLocale({ k: base, k__af: af }, "k", "af")).toBe(af)
    expect(pickTemplateForLocale({ k: base, k__af: { ...af, active: false } }, "k", "af")).toBe(base)
    expect(pickTemplateForLocale({ k: base, k__af: { ...af, language: "zu" } }, "k", "af")).toBe(base)
    expect(pickTemplateForLocale({ k: base }, "k", "af")).toBe(base)
    expect(pickTemplateForLocale({ k: base, k__en: { id: "x", language: "en", active: true } }, "k", "en")).toBe(base)
  })
})

describe("WhatsApp free text", () => {
  // English sends call WA_TEMPLATES directly; the catalogue's English must say
  // the same so the two never drift.
  it("the English catalogue matches WA_TEMPLATES word for word", () => {
    const en = localizedWaTemplates("en")
    expect(en.application_submitted("Thandi", "APP-1", "R5 000", "Acme")).toBe(WA_TEMPLATES.application_submitted("Thandi", "APP-1", "R5 000", "Acme"))
    expect(en.application_approved("Thandi", "R5 000", "APP-1")).toBe(WA_TEMPLATES.application_approved("Thandi", "R5 000", "APP-1"))
    expect(en.loan_disbursed("Thandi", "R5 000", "1 Nov")).toBe(WA_TEMPLATES.loan_disbursed("Thandi", "R5 000", "1 Nov"))
    expect(en.payment_received("Thandi", "R500", "R4 500")).toBe(WA_TEMPLATES.payment_received("Thandi", "R500", "R4 500"))
    expect(en.payment_overdue_1d("Thandi", "R500", "LN-1")).toBe(WA_TEMPLATES.payment_overdue_1d("Thandi", "R500", "LN-1"))
    expect(en.payment_overdue_7d("Thandi", "R500", "LN-1", "011")).toBe(WA_TEMPLATES.payment_overdue_7d("Thandi", "R500", "LN-1", "011"))
  })

  it.each([
    ["af", "Jou betaling van *R500*"],
    ["zu", "Inkokhelo yakho ka-*R500*"],
    ["xh", "Intlawulo yakho ye-*R500*"],
  ] as const)("%s carries every figure", (locale, phrase) => {
    const text = localizedWaTemplates(locale).payment_overdue_1d("Thandi", "R500", "LN-1")
    expect(text).toContain(phrase)
    expect(text).toContain("LN-1")
    expect(text).toContain("Thandi")
  })
})

describe("localised emails", () => {
  const identity = parseLenderIdentity(VALID_LENDER_COLUMNS)

  it.each([
    ["af", "Jou lening is goedgekeur"],
    ["zu", "Imalimboleko yakho ivunyiwe"],
    ["xh", "Imali-mboleko yakho ivunyiwe"],
  ] as const)("approved email in %s: translated copy, same figures, English regulatory footer", (locale, heading) => {
    const html = applicationApprovedEmail(identity, "Thandi", "APP-1", "Personal", 450_000, "https://app.example/portal", locale)
    expect(html).toContain(heading)
    expect(html).not.toContain("Your loan has been approved")
    expect(html).toContain("R 4,500.00")
    expect(html).toContain("NCR Registered Credit Provider &middot; NCRCP99999")
  })

  it("payment received and overdue emails translate and keep the reference", () => {
    expect(paymentReceivedEmail(identity, "Thandi", 50_000, "LN-1", 400_000, "af")).toContain("Ons het jou betaling ontvang")
    const overdue = overdueHtml(identity, "Thandi", 7, "LN-1", "xh")
    expect(overdue).toContain("ngeentsuku ezi-7")
    expect(overdue).toContain("<strong>LN-1</strong>")
  })
})

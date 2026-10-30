import { beforeEach, describe, expect, it, vi } from "vitest"
import { approvedAffordabilityResult } from "./approval.integration-fixture"

const m = vi.hoisted(() => ({
  template: vi.fn(), version: vi.fn(), application: vi.fn(), tenant: vi.fn(), config: vi.fn(), user: vi.fn(), pdf: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    documentTemplate: { findFirst: m.template }, documentTemplateVersion: { findFirst: m.version }, loanApplication: { findFirst: m.application },
    tenant: { findUniqueOrThrow: m.tenant }, tenantConfig: { findUnique: m.config }, user: { findFirst: m.user },
  },
}))
vi.mock("@/lib/jurisdiction/load.server", () => ({ ensureActiveJurisdiction: async () => ({ jurisdiction: "LS", currency: "LSL" }) }))
vi.mock("@/lib/config/identity", () => ({ findLenderIdentity: async () => ({ legalName: "Demo Basotho Lending (Pty) Ltd", ncrNumber: null, registeredOfficeLines: ["1 Demo Road"] }) }))
vi.mock("@/lib/documents/html-to-pdf", () => ({ htmlToPdf: async (html: string) => { m.pdf(html); return Buffer.from(html) } }))

import { MissingTokenError, TemplateUnavailableError } from "@/lib/documents/render"
import { renderLoanDocument } from "./render"
import { SAMPLE_BANNER_TEXT } from "./keys"

const args = { tenantId: "t1", applicationId: "a1", kind: "KEY_FACTS_STATEMENT" as const, staffUserId: null }
const goodTemplate = { id: "tpl1", name: "Key facts statement", kind: "CUSTOM", isActive: true, currentVersionId: "v1", requiresApproval: true }
const goodVersion = (bodyHtml = "<p>{{client.fullName}} {{quote.principal}}</p>") => ({ id: "v1", version: 3, status: "ACTIVE", bodyHtml, approvedById: "u9", approvedAt: new Date() })

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.template.mockResolvedValue(goodTemplate)
  m.version.mockResolvedValue(goodVersion())
  m.application.mockResolvedValue({
    id: "a1", reference: "APP-1", status: "APPROVED", repaymentMethod: "EFT", client: { firstName: "Thabo", lastName: "Synthetic" }, product: { name: "Personal Loan" },
    affordabilityResult: approvedAffordabilityResult({ principalCents: 500_000, termDays: 90, productId: "p", interestRatePm: 0.023, interestModel: "REDUCING_BALANCE", monthlyServiceFeeCents: 6_900 }),
  })
  m.tenant.mockResolvedValue({ id: "t1" })
  m.config.mockResolvedValue({ isDemoLender: false })
  m.user.mockResolvedValue(null)
})

describe("renderLoanDocument", () => {
  it("renders the current approved version with the approved figures, and hashes its wording", async () => {
    const doc = await renderLoanDocument(args)
    expect(doc).toMatchObject({ templateId: "tpl1", templateKey: "non_nca_key_facts", versionNumber: 3, sample: false })
    expect(doc.pdf.toString()).toContain("Thabo Synthetic")
    expect(doc.pdf.toString()).toMatch(/M 5,000\.00|R 5,000\.00/)
    expect(doc.templateContentSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(doc.pdf.toString()).not.toContain(SAMPLE_BANNER_TEXT)
  })

  it("opens a demo lender's document with the SAMPLE banner", async () => {
    m.config.mockResolvedValue({ isDemoLender: true })
    const doc = await renderLoanDocument(args)
    expect(doc.sample).toBe(true)
    expect(doc.pdf.toString().startsWith("<p")).toBe(true)
    expect(doc.pdf.toString()).toContain("SAMPLE")
    expect(doc.pdf.toString()).toContain("legal team supplies wording")
  })

  it.each([
    ["no template", () => m.template.mockResolvedValue(null)],
    ["a template out of use", () => m.template.mockResolvedValue({ ...goodTemplate, isActive: false })],
    ["a template with no current version", () => m.template.mockResolvedValue({ ...goodTemplate, currentVersionId: null })],
    ["a template of another kind", () => m.template.mockResolvedValue({ ...goodTemplate, kind: "SYSTEM" })],
    ["a current version that is not ACTIVE", () => m.version.mockResolvedValue(null)],
    ["a version nobody approved", () => m.version.mockResolvedValue({ ...goodVersion(), approvedById: null })],
  ])("refuses %s", async (_label, arrange) => {
    arrange()
    await expect(renderLoanDocument(args)).rejects.toBeInstanceOf(TemplateUnavailableError)
    expect(m.pdf).not.toHaveBeenCalled()
  })

  it("never prints a silent blank: an unresolved token refuses", async () => {
    m.version.mockResolvedValue(goodVersion("<p>{{client.fullName}} {{tenant.ncrNumber}} {{client.physicalAddress}}</p>"))
    const error = await renderLoanDocument(args).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MissingTokenError)
    expect((error as MissingTokenError).missing).toEqual(["tenant.ncrNumber", "client.physicalAddress"])
    expect(m.pdf).not.toHaveBeenCalled()
  })
})

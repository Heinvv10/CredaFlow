import { beforeEach, describe, expect, it, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { expectNoOtherLender } from "@/lib/website/__fixtures__/other-lender"
import { publicLoanProducts, type LivePricing } from "@/lib/public-loan-products"

const mocks = vi.hoisted(() => ({ findLenderIdentity: vi.fn(), getLivePricingServer: vi.fn(), insuranceFindMany: vi.fn() }))
vi.mock("@/lib/config/identity", async () => ({
  ...(await vi.importActual<typeof import("@/lib/config/identity-schema")>("@/lib/config/identity-schema")),
  findLenderIdentity: mocks.findLenderIdentity,
}))
vi.mock("@/lib/public-loan-products-server", () => ({ getLivePricingServer: mocks.getLivePricingServer }))
vi.mock("@/lib/prisma", () => ({ prisma: { insuranceProduct: { findMany: mocks.insuranceFindMany } } }))

import { buildKnowledge, loadKnowledge } from "./knowledge"
import { chatGreeting } from "./constants"
import { buildSystemPrompt, systemRules } from "./prompt"

const personal = publicLoanProducts.find((p) => p.code === "personal")!
const pricing = (p: typeof personal): LivePricing => ({
  interestRatePm: p.interestRatePm, interestModel: p.interestModel, productType: p.productType,
  initiationFeeModel: p.initiationFeeModel, initiationFeePct: p.initiationFeePct, initiationFeeMax: p.initiationFeeMax,
  monthlyServiceFee: p.monthlyServiceFee, minAmount: p.minAmount, maxAmount: p.maxAmount, minTermDays: 30, maxTermDays: 360,
} as LivePricing)

describe("buildKnowledge", () => {
  const k = buildKnowledge({ identity: ACME_LENDER, products: [personal], insurance: [{ name: "Acme Funeral Plan", type: "FUNERAL_COVER" }] })

  it("carries the tenant's identity facts", () => {
    for (const v of [ACME_LENDER.legalName, ACME_LENDER.ncrNumber, ACME_LENDER.fspNumber, ACME_LENDER.publicEmail, ACME_LENDER.publicPhone, ACME_LENDER.companyRegNumber]) expect(k).toContain(v)
  })
  it("carries the tenant's products and insurance names", () => {
    expect(k).toContain(personal.label)
    expect(k).toContain("Acme Funeral Plan")
  })
  it("names no other lender", () => {
    expectNoOtherLender(k)
    expectNoOtherLender(systemRules("Acme Lending"))
    expectNoOtherLender(chatGreeting("Sam", "Acme Lending"))
  })
  it("omits a product the tenant has no row for", () => {
    const other = publicLoanProducts.find((p) => p.code !== "personal")!
    expect(k).not.toContain(other.label)
  })
  it("omits optional regulatory facts when unset and prints them when set", () => {
    expect(k).not.toMatch(/NCR status|registered on|authorised on/i)
    const set = buildKnowledge({ identity: { ...ACME_LENDER, ncrRegistrationDate: "2015-03-02", ncrStatus: "Registered", headOfficeCity: "Pretoria" }, products: [], insurance: [] })
    expect(set).toContain("2 March 2015")
    expect(set).toContain("Registered")
    expect(set).toContain("Pretoria")
  })
  it("prints no WhatsApp line when none is configured", () => {
    expect(k).not.toMatch(/whatsapp/i)
  })
  it("is deterministic (prompt-cache prefix must not drift)", () => {
    expect(buildKnowledge({ identity: ACME_LENDER, products: [personal], insurance: [{ name: "Acme Funeral Plan", type: "FUNERAL_COVER" }] })).toBe(k)
  })
})

describe("loadKnowledge", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findLenderIdentity.mockResolvedValue(ACME_LENDER)
    mocks.getLivePricingServer.mockResolvedValue({ personal: pricing(personal) })
    mocks.insuranceFindMany.mockResolvedValue([{ name: "Acme Funeral Plan", type: "FUNERAL_COVER" }])
  })
  it("reads identity, live products and active insurance for the given tenant", async () => {
    const r = await loadKnowledge("tenant-1")
    expect(mocks.findLenderIdentity).toHaveBeenCalledWith("tenant-1")
    expect(mocks.getLivePricingServer).toHaveBeenCalledWith("tenant-1")
    expect(mocks.insuranceFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-1", active: true } }))
    expect(r?.identity).toBe(ACME_LENDER)
    expect(r?.knowledge).toContain(ACME_LENDER.ncrNumber)
    expect(r?.knowledge).toContain("Acme Funeral Plan")
    expect(r?.knowledge).toContain(personal.label)
    expectNoOtherLender(r!.knowledge)
  })
  it("returns null, reading nothing else, when the tenant has no identity", async () => {
    mocks.findLenderIdentity.mockResolvedValue(null)
    expect(await loadKnowledge("tenant-1")).toBeNull()
    expect(mocks.getLivePricingServer).not.toHaveBeenCalled()
  })
})

describe("hand-off wording", () => {
  const rules = systemRules("Acme Lending")
  it("rules end by telling the assistant to leave the hand-off message to the website, with no promise of a call or a time", () => {
    expect(rules.endsWith(" When you hand off, do not mention consultants, availability or what happens next; the website adds that message itself. Only write a reply if there is something else the visitor needs to hear, for example asking them not to share personal documents or numbers. Never promise a response time or a phone call.")).toBe(true)
    expect(rules).not.toContain("will call them")
    expect(rules).toContain("If the answer is not there, say you don't have that information and hand off.")
    expect(rules).not.toMatch(/stay on/i)
  })
  it("the greeting says the same and no more", () => {
    expect(chatGreeting("Sam", "Acme Lending")).toContain("For those, I'll pass you to a consultant.")
    expect(chatGreeting("Sam", "Acme Lending")).toContain("Acme Lending")
  })
})

describe("page links", () => {
  it("rules ask for descriptive markdown links to pages named in KNOWLEDGE", () => {
    const rules = systemRules("Acme Lending")
    expect(rules).toContain("write it as a markdown link with a short description, for example [our loan calculators](/site/calculators) or [apply online](/site/apply). Only link to pages named in KNOWLEDGE.")
    expect(rules).toContain("send them to [our calculators](/site/calculators) and repeat only figures")
  })
  it("every page named in KNOWLEDGE is a kept page", () => {
    const k = buildKnowledge({ identity: ACME_LENDER, products: [], insurance: [] })
    for (const gone of ["/site/pricing", "/site/faq", "/site/how-it-works", "/site/about"]) expect(k).not.toContain(gone)
    expect(systemRules("X")).not.toContain("/site/pricing")
  })
})

describe("buildSystemPrompt", () => {
  it("puts the rules, naming the brand, before the knowledge", () => {
    const p = buildSystemPrompt("KNOWLEDGE", "Acme Lending")
    expect(p.indexOf(systemRules("Acme Lending"))).toBe(0)
    expect(p).toContain("Acme Lending")
    expect(p).toContain("KNOWLEDGE")
  })
})

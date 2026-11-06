import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TokenContext } from "@/lib/documents/tokens"

const m = vi.hoisted(() => ({ product: vi.fn(), renderedPdf: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanProduct: { findFirst: m.product },
    client: { findFirst: async () => ({ id: "c1", firstName: "Wanjiru", lastName: "Synthetic" }) },
    tenant: { findUniqueOrThrow: async () => ({ id: "t1" }) },
    tenantConfig: { findUnique: async () => ({ isDemoLender: true }) },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({
      clientDocument: { create: async () => ({ id: "doc1" }), update: async () => ({}) },
      documentAccessLog: { create: async () => ({}) },
    }),
  },
}))
vi.mock("@/lib/config/identity", () => ({ findLenderIdentity: async () => ({ legalName: "Demo Nairobi Credit Ltd", ncrNumber: null, registeredOfficeLines: ["1 Demo Road"] }) }))
vi.mock("@/lib/audit", () => ({ logAuditStrict: async () => undefined, AuditAction: { KEY_FACTS_QUOTED: "KEY_FACTS_QUOTED" } }))
vi.mock("@/lib/storage", () => ({ saveFile: async () => ({ storagePath: "p", fileSize: 1 }), deleteFile: async () => undefined }))
vi.mock("./render", () => ({
  currentApprovedTemplate: async () => ({ template: { id: "tpl" }, version: { id: "v1", version: 1, bodyHtml: "<p>{{product.regulatorApprovalRef}}</p>" } }),
  renderedPdf: m.renderedPdf,
}))

import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { renderTokens } from "@/lib/documents/tokens"
import { issueIndicativeKeyFacts } from "./pre-submission"

const MPESA30 = {
  id: "p1", code: "MPESA30", name: "M-Pesa 30-Day Loan", productType: "MICRO", minAmount: 100_000, maxAmount: 5_000_000, minTermDays: 30, maxTermDays: 30,
  interestRatePm: 0.04, interestModel: "DAILY_ACCRUAL", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0.05, initiationFeeMax: 250_000, monthlyServiceFee: 0,
}

beforeEach(() => {
  setActiveJurisdiction({ jurisdiction: "KE", currency: "KES" })
  m.renderedPdf.mockReset()
  m.renderedPdf.mockResolvedValue(Buffer.from("%PDF"))
})
afterEach(() => resetActiveJurisdiction())

const issue = () => issueIndicativeKeyFacts({ tenantId: "t1", clientId: "c1", actor: { type: "client", clientId: "c1", email: null }, productCode: "MPESA30", amountCents: 1_000_000, termDays: undefined })

describe("the indicative key facts statement before applying (Kenya)", () => {
  it("prints the product's CBK approval reference, as the approved statement does", async () => {
    m.product.mockResolvedValue({ ...MPESA30, regulatorApprovalRef: "CBK/DEMO/0001" })
    expect(await issue()).toMatchObject({ ok: true })
    const [body, ctx] = m.renderedPdf.mock.calls[0] as [string, TokenContext]
    expect(renderTokens(body, ctx)).toEqual({ html: "<p>CBK/DEMO/0001</p>", missing: [] })
  })

  it("leaves it missing when the product has none, so the statement refuses rather than print a blank", async () => {
    m.product.mockResolvedValue({ ...MPESA30, regulatorApprovalRef: null })
    await issue()
    const [body, ctx] = m.renderedPdf.mock.calls[0] as [string, TokenContext]
    expect(renderTokens(body, ctx).missing).toEqual(["product.regulatorApprovalRef"])
  })
})

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: { documentTemplate: { upsert: vi.fn() } },
}))

import { seedDocumentTemplates } from "./seed-document-templates"
import { prisma } from "@/lib/prisma"

beforeEach(() => vi.clearAllMocks())

const SYSTEM_KEYS = [
  "credit_agreement",
  "pre_agreement",
  "debit_order_mandate",
  "section_129",
  "certificate_of_balance",
  "fais_disclosure",
  "customer_statement",
  "affordability_assessment",
]

const CUSTOM_KEYS = [
  "electronic_signature_consent",
  "collection_cost_recovery_agreement",
  "paid_up_letter",
  "settlement_letter",
  "electronic_application_form",
]

describe("seedDocumentTemplates", () => {
  it("upserts all 13 catalogue rows", async () => {
    vi.mocked(prisma.documentTemplate.upsert).mockResolvedValue({} as any)
    await seedDocumentTemplates("t1")
    expect(prisma.documentTemplate.upsert).toHaveBeenCalledTimes(13)
  })

  it("upserts the 8 SYSTEM rows with kind SYSTEM and a non-null systemGenerator", async () => {
    vi.mocked(prisma.documentTemplate.upsert).mockResolvedValue({} as any)
    await seedDocumentTemplates("t1")
    const calls = vi.mocked(prisma.documentTemplate.upsert).mock.calls
    for (const key of SYSTEM_KEYS) {
      const call = calls.find((c) => c[0].where.tenantId_key?.key === key)
      expect(call, `missing upsert for ${key}`).toBeDefined()
      expect(call![0].where).toEqual({ tenantId_key: { tenantId: "t1", key } })
      expect(call![0].create.kind).toBe("SYSTEM")
      expect(call![0].create.systemGenerator).toEqual(expect.any(String))
      expect(call![0].create.systemGenerator).not.toBeNull()
    }
  })

  it("upserts the 5 CUSTOM rows with kind CUSTOM", async () => {
    vi.mocked(prisma.documentTemplate.upsert).mockResolvedValue({} as any)
    await seedDocumentTemplates("t1")
    const calls = vi.mocked(prisma.documentTemplate.upsert).mock.calls
    for (const key of CUSTOM_KEYS) {
      const call = calls.find((c) => c[0].where.tenantId_key?.key === key)
      expect(call, `missing upsert for ${key}`).toBeDefined()
      expect(call![0].where).toEqual({ tenantId_key: { tenantId: "t1", key } })
      expect(call![0].create.kind).toBe("CUSTOM")
    }
  })

  it("marks collection_cost_recovery_agreement and settlement_letter as requiresApproval", async () => {
    vi.mocked(prisma.documentTemplate.upsert).mockResolvedValue({} as any)
    await seedDocumentTemplates("t1")
    const calls = vi.mocked(prisma.documentTemplate.upsert).mock.calls
    for (const key of ["collection_cost_recovery_agreement", "settlement_letter"]) {
      const call = calls.find((c) => c[0].where.tenantId_key?.key === key)
      expect(call![0].create.requiresApproval).toBe(true)
    }
  })
})

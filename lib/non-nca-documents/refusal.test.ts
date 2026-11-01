import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ findFirst: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { loanApplication: { findFirst: m.findFirst } } }))

import { keyFactsRefusal } from "./refusal"

beforeEach(() => { m.findFirst.mockReset() })

describe("keyFactsRefusal", () => {
  it("lets a PASQ application through untouched", async () => {
    m.findFirst.mockResolvedValue({ disclosureRegime: "NCA_PASQ", agreementSignedAt: null })
    expect(await keyFactsRefusal("t", "a")).toBeNull()
  })

  it("sends a key-facts application's PASQ ceremony call to its loan documents, with a 409", async () => {
    m.findFirst.mockResolvedValue({ disclosureRegime: "KEY_FACTS", agreementSignedAt: null })
    const res = await keyFactsRefusal("t", "a")
    expect(res?.status).toBe(409)
    expect(await res?.json()).toMatchObject({ nonNcaDocuments: true })
  })
})

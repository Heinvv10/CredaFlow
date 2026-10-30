import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ findFirst: vi.fn(), problem: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { loanApplication: { findFirst: m.findFirst } } }))
vi.mock("./state", () => ({ documentProblem: m.problem }))

import { keyFactsRefusal } from "./refusal"

beforeEach(() => { m.findFirst.mockReset(); m.problem.mockReset() })

describe("keyFactsRefusal", () => {
  it("lets a PASQ application through untouched", async () => {
    m.findFirst.mockResolvedValue({ disclosureRegime: "NCA_PASQ", agreementSignedAt: null })
    expect(await keyFactsRefusal("t", "a")).toBeNull()
    expect(await keyFactsRefusal("t", "a", "disburse")).toBeNull()
    expect(m.problem).not.toHaveBeenCalled()
  })

  it("sends a key-facts application's PASQ ceremony call to its loan documents, with a 409", async () => {
    m.findFirst.mockResolvedValue({ disclosureRegime: "KEY_FACTS", agreementSignedAt: null })
    const res = await keyFactsRefusal("t", "a")
    expect(res?.status).toBe(409)
    expect(await res?.json()).toMatchObject({ nonNcaDocuments: true })
  })

  it("on disbursement names the missing document or signature (422), and only a sound signed pair reaches the unavailable-payout answer (409)", async () => {
    m.findFirst.mockResolvedValue({ disclosureRegime: "KEY_FACTS", agreementSignedAt: null })
    const unsigned = await keyFactsRefusal("t", "a", "disburse")
    expect(unsigned?.status).toBe(422)
    expect(await unsigned?.json()).toMatchObject({ error: expect.stringContaining("has not signed"), disbursementPrecondition: "non_nca_documents" })
    expect(m.problem).not.toHaveBeenCalled()

    m.findFirst.mockResolvedValue({ disclosureRegime: "KEY_FACTS", agreementSignedAt: new Date() })
    m.problem.mockResolvedValue("the wording of template version 1 changed after the loan agreement was issued")
    const changed = await keyFactsRefusal("t", "a", "disburse")
    expect(changed?.status).toBe(422)
    expect(m.problem).toHaveBeenCalledWith("a", false)

    m.problem.mockResolvedValue(null)
    const ready = await keyFactsRefusal("t", "a", "disburse")
    expect(ready?.status).toBe(409)
    expect(await ready?.json()).toMatchObject({ disbursementPrecondition: "non_nca_payout_unavailable" })
  })
})

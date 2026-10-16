import { describe, expect, it, vi } from "vitest"
import { loadPortalDeclineView } from "./decline-view"

const contact = { phone: "+27 11 555 0100", email: "help@lender.example" }

function db(provider: string | null) {
  return { creditBureauCheck: { findFirst: vi.fn(async () => (provider ? { provider } : null)) } } as unknown as Parameters<typeof loadPortalDeclineView>[0]
}

describe("loadPortalDeclineView", () => {
  // Lerato, Fair Score audit 2026-10-16: a bureau-score decline named no bureau and gave no next steps.
  it("names the bureau and how to reach it on a bureau decline, with next steps", async () => {
    const view = await loadPortalDeclineView(db("experian"), "t1",
      { id: "a1", declineCategory: "BUREAU_SCORE", decisionReason: "Your credit record at the credit bureau does not meet our lending criteria." }, contact)
    expect(view.bureau).toEqual({ name: "Experian", phone: "0861 105 665", website: "www.experian.co.za" })
    expect(view.nextSteps.join(" ")).toContain("free credit report")
    expect(view.nextSteps.join(" ")).toContain("dispute")
    expect(view.nextSteps.join(" ")).toContain("+27 11 555 0100")
  })

  it("names no bureau for a non-bureau decline", async () => {
    const reader = db("experian")
    const view = await loadPortalDeclineView(reader, "t1", { id: "a1", declineCategory: "AFFORDABILITY", decisionReason: "x" }, contact)
    expect(view.bureau).toBeNull()
    expect(reader.creditBureauCheck.findFirst).not.toHaveBeenCalled()
  })

  it("an old decline stored as the bare word still shows the category's client reason when blank", async () => {
    const view = await loadPortalDeclineView(db(null), "t1", { id: "a1", declineCategory: "IDENTITY", decisionReason: null }, contact)
    expect(view.reason).toBe("We could not verify your identity.")
  })
})

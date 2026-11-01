import { describe, expect, it } from "vitest"
import { KEY_FACTS_CREDIT_LIFE, approvalEvidenceRules, keyFactsCreditLifeRefusal } from "./regime-evidence"

describe("approvalEvidenceRules", () => {
  it("requires every NCA item for an NCA_PASQ application, and for one with no regime recorded (fail closed)", () => {
    for (const application of [{ disclosureRegime: "NCA_PASQ" }, {}, { disclosureRegime: null }, { disclosureRegime: "SOMETHING_ELSE" }]) {
      expect(approvalEvidenceRules(application)).toEqual({ creditLifeElection: true, affordabilityDeclaration: true, recklessLendingAssessment: true, bureauCheck: true, screeningProvider: false })
    }
  })

  it("asks a KEY_FACTS application for none of the four, but for a screening provider", () => {
    expect(approvalEvidenceRules({ disclosureRegime: "KEY_FACTS" })).toEqual({ creditLifeElection: false, affordabilityDeclaration: false, recklessLendingAssessment: false, bureauCheck: false, screeningProvider: true })
  })
})

describe("credit life on a KEY_FACTS loan", () => {
  it("is priced as no offer: declined, premium zero", () => {
    expect(KEY_FACTS_CREDIT_LIFE).toEqual({ election: "DECLINED", offered: false, monthlyPremiumCents: 0 })
  })

  it("refuses an accepted election, and only on a KEY_FACTS application", () => {
    expect(keyFactsCreditLifeRefusal({ disclosureRegime: "KEY_FACTS", creditLifeElection: "ACCEPTED" })).toMatch(/Credit life cannot be added/)
    expect(keyFactsCreditLifeRefusal({ disclosureRegime: "KEY_FACTS", creditLifeElection: "DECLINED" })).toBeNull()
    expect(keyFactsCreditLifeRefusal({ disclosureRegime: "KEY_FACTS", creditLifeElection: null })).toBeNull()
    expect(keyFactsCreditLifeRefusal({ disclosureRegime: "NCA_PASQ", creditLifeElection: "ACCEPTED" })).toBeNull()
  })
})

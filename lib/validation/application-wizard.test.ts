import { describe, expect, it } from "vitest"
import {
  validateStep1ClientSelect,
  validateStep2LoanParams,
  validateStep3Affordability,
  validateStep4Review,
  validateAllApplication,
  deriveAffordabilityFlag,
} from "./application-wizard"
import {
  EMPTY_APPLICATION_WIZARD_DATA,
  type ApplicationProduct,
} from "@/components/applications/wizard/types"

const PRODUCT: ApplicationProduct = {
  productType: "MICRO",
  id: "p1",
  name: "Personal Loan",
  code: "PL",
  minAmount: 1000,
  maxAmount: 50000,
  minTermDays: 30,
  maxTermDays: 365,
  interestRate: 0.05,
  interestRatePm: 0.05,
  interestModel: "FLAT",
  initiationFeeModel: "FLAT_PCT" as const,
  initiationFeePct: 0,
  initiationFeeMax: 0,
  monthlyServiceFee: 0,
}

describe("validateStep1ClientSelect", () => {
  it("flags empty clientId", () => {
    const e = validateStep1ClientSelect(EMPTY_APPLICATION_WIZARD_DATA)
    expect(e.clientId).toBeDefined()
  })

  it("passes when clientId is set", () => {
    expect(validateStep1ClientSelect({ ...EMPTY_APPLICATION_WIZARD_DATA, clientId: "c1" })).toEqual({})
  })
})

describe("validateStep2LoanParams", () => {
  const full = {
    ...EMPTY_APPLICATION_WIZARD_DATA,
    clientId: "c1",
    productId: "p1",
    appliedAmount: "5000",
    appliedTermDays: "90",
    purpose: "School fees",
    purposeDetails: "",
  }

  it("passes when complete and within product bounds", () => {
    expect(validateStep2LoanParams(full, [PRODUCT])).toEqual({})
  })

  it("flags missing product", () => {
    expect(validateStep2LoanParams({ ...full, productId: "" }, [PRODUCT]).productId).toBeDefined()
  })

  it("flags amount below product minimum", () => {
    expect(validateStep2LoanParams({ ...full, appliedAmount: "500" }, [PRODUCT]).appliedAmount).toBeDefined()
  })

  it("flags amount above product maximum", () => {
    expect(validateStep2LoanParams({ ...full, appliedAmount: "999999" }, [PRODUCT]).appliedAmount).toBeDefined()
  })

  it("flags non-numeric amount", () => {
    expect(validateStep2LoanParams({ ...full, appliedAmount: "abc" }, [PRODUCT]).appliedAmount).toBeDefined()
  })

  it("flags term below minimum", () => {
    expect(validateStep2LoanParams({ ...full, appliedTermDays: "7" }, [PRODUCT]).appliedTermDays).toBeDefined()
  })

  it("flags term above maximum", () => {
    expect(validateStep2LoanParams({ ...full, appliedTermDays: "9999" }, [PRODUCT]).appliedTermDays).toBeDefined()
  })

  it("flags empty purpose", () => {
    expect(validateStep2LoanParams({ ...full, purpose: "" }, [PRODUCT]).purpose).toBeDefined()
  })

  it("flags unknown product id (product list mismatch)", () => {
    expect(validateStep2LoanParams({ ...full, productId: "ghost" }, [PRODUCT]).productId).toBeDefined()
  })

  // Pins ApplicationProduct.{min,max}Amount as rand. DB stores cents; the SSR/API
  // loaders divide by 100 before handing the shape to the wizard. If anyone ever
  // pipes the raw cents value through again, this test fails first.
  it("treats product.minAmount/maxAmount as rand (not cents)", () => {
    const rand: ApplicationProduct = { ...PRODUCT, minAmount: 100, maxAmount: 2000 }
    // Below rand bound — should reject
    expect(
      validateStep2LoanParams({ ...full, appliedAmount: "50" }, [rand]).appliedAmount,
    ).toMatch(/R 100\b/)
    // Above rand bound — should reject
    expect(
      validateStep2LoanParams({ ...full, appliedAmount: "5000" }, [rand]).appliedAmount,
    ).toMatch(/R 2000\b/)
    // Inside rand bound — should pass
    expect(
      validateStep2LoanParams({ ...full, appliedAmount: "500" }, [rand]).appliedAmount,
    ).toBeUndefined()
  })
})

describe("validateStep3Affordability", () => {
  const base = {
    ...EMPTY_APPLICATION_WIZARD_DATA,
    clientId: "c1",
    productId: "p1",
    appliedAmount: "5000",
    appliedTermDays: "90",
    purpose: "School fees",
    monthlyInstalment: "1750.00",
    totalInterest: "250.00",
    totalRepayable: "5250.00",
  }

  it("passes on PASS flag", () => {
    expect(validateStep3Affordability({ ...base, affordabilityFlag: "PASS" })).toEqual({})
  })

  it("passes on MARGINAL flag", () => {
    expect(validateStep3Affordability({ ...base, affordabilityFlag: "MARGINAL" })).toEqual({})
  })

  it("requires recklessLendingConfirmed when FAIL", () => {
    const e = validateStep3Affordability({ ...base, affordabilityFlag: "FAIL", recklessLendingConfirmed: false })
    expect(e.recklessLendingConfirmed).toBeDefined()
  })

  it("passes on FAIL with recklessLendingConfirmed", () => {
    expect(
      validateStep3Affordability({ ...base, affordabilityFlag: "FAIL", recklessLendingConfirmed: true }),
    ).toEqual({})
  })

  it("flags missing affordabilityFlag (calc not yet run)", () => {
    const e = validateStep3Affordability({ ...base, affordabilityFlag: "" })
    expect(e.affordabilityFlag).toBeDefined()
  })
})

describe("validateStep4Review", () => {
  const baseData = {
    ...EMPTY_APPLICATION_WIZARD_DATA,
    creditLifeElection: "DECLINED" as const,
    creditLifeDisclosureAcknowledged: true,
    pasqAcknowledged: false,
    affordabilityDeclared: false,
    recklessLendingConfirmed: false,
    affordabilityFlag: "PASS" as const,
  }

  describe("forReview=false (draft path)", () => {
    it("returns empty errors regardless of ack state", () => {
      expect(validateStep4Review(baseData, { forReview: false })).toEqual({})
    })

    it("returns empty even when affordabilityFlag is FAIL and reckless ack is missing", () => {
      const d = { ...baseData, affordabilityFlag: "FAIL" as const }
      expect(validateStep4Review(d, { forReview: false })).toEqual({})
    })

    it("returns empty when called with no opts (backward-compat default)", () => {
      expect(validateStep4Review(baseData)).toEqual({})
    })
  })

  describe("forReview=true (submit-for-review path)", () => {
    it("accepts when all required acks are true and flag is PASS", () => {
      const d = {
        ...baseData,
        pasqAcknowledged: true,
        affordabilityDeclared: true,
      }
      expect(validateStep4Review(d, { forReview: true })).toEqual({})
    })

    it("requires confirmation that the PASQ will follow during review", () => {
      const d = {
        ...baseData,
        pasqAcknowledged: false,
        affordabilityDeclared: true,
      }
      expect(validateStep4Review(d, { forReview: true })).toEqual({
        pasqAcknowledged: "Confirm the client understands the PASQ will follow during review",
      })
    })

    it("requires an explicit credit-life election and exact-offer acknowledgement", () => {
      const d = {
        ...baseData,
        creditLifeElection: "" as const,
        creditLifeDisclosureAcknowledged: false,
        pasqAcknowledged: true,
        affordabilityDeclared: true,
      }
      expect(validateStep4Review(d, { forReview: true })).toEqual({
        creditLifeElection: "The client must accept or decline the offered credit-life cover",
        creditLifeDisclosureAcknowledged: "Confirm the exact offer was shown before the PASQ",
      })
    })

    it("requires affordabilityDeclared", () => {
      const d = {
        ...baseData,
        pasqAcknowledged: true,
        affordabilityDeclared: false,
      }
      expect(validateStep4Review(d, { forReview: true })).toEqual({
        affordabilityDeclared: "Required to submit for review",
      })
    })

    // `recklessLendingConfirmed` is enforced by `validateStep3Affordability`
    // (composed before Step 4 in `validateAllApplication`). Step 4 deliberately
    // does NOT re-check it — see the comment in `validateStep4Review` and the
    // `validateAllApplication` test below ("Step 3 reckless message survives
    // Step 4 composition on FAIL").
    it("does not re-check recklessLendingConfirmed when flag is FAIL", () => {
      const d = {
        ...baseData,
        pasqAcknowledged: true,
        affordabilityDeclared: true,
        affordabilityFlag: "FAIL" as const,
        recklessLendingConfirmed: false,
      }
      expect(validateStep4Review(d, { forReview: true })).toEqual({})
    })

    it("returns only PASQ + affordabilityDeclared keys when both are missing on FAIL", () => {
      const d = {
        ...baseData,
        affordabilityFlag: "FAIL" as const,
      }
      const errs = validateStep4Review(d, { forReview: true })
      expect(errs).toEqual({
        pasqAcknowledged: "Confirm the client understands the PASQ will follow during review",
        affordabilityDeclared: "Required to submit for review",
      })
      // Explicit negative contract: Step 4 must NOT emit this key —
      // Step 3 owns it (see `validateAllApplication` regression test below).
      expect(errs).not.toHaveProperty("recklessLendingConfirmed")
    })
  })
})

describe("validateAllApplication", () => {
  it("collates errors across all steps (draft path — acks not required)", () => {
    const e = validateAllApplication(EMPTY_APPLICATION_WIZARD_DATA, [PRODUCT])
    expect(e.clientId).toBeDefined()
    expect(e.productId).toBeDefined()
    expect(e.affordabilityFlag).toBeDefined()
    // Draft path: ack fields are NOT required (forReview defaults to false)
    expect(e.affordabilityDeclared).toBeUndefined()
  })

  it("forReview=false: surfaces Step 1 errors only, ignores empty acks", () => {
    const d = {
      ...EMPTY_APPLICATION_WIZARD_DATA,
      clientId: "",
      productId: "p1",
      appliedAmount: "5000",
      appliedTermDays: "30",
      purpose: "Test",
      affordabilityFlag: "PASS" as const,
      monthlyInstalment: "100",
      pasqAcknowledged: false,
      affordabilityDeclared: false,
    }
    const errs = validateAllApplication(d, [PRODUCT], { forReview: false })
    expect(errs.clientId).toBeDefined()
    expect(errs.pasqAcknowledged).toBeUndefined()
    expect(errs.affordabilityDeclared).toBeUndefined()
  })

  it("Step 3 reckless message survives Step 4 composition on FAIL", () => {
    // Regression guard for MEDIUM #2: previously, both Step 3 and Step 4
    // emitted `recklessLendingConfirmed` with different messages. The Step 4
    // spread overwrote Step 3. Step 4 now leaves the key alone, so Step 3's
    // message must reach the caller (and the API's 400 response).
    const d = {
      ...EMPTY_APPLICATION_WIZARD_DATA,
      clientId: "c1",
      productId: "p1",
      appliedAmount: "5000",
      appliedTermDays: "30",
      purpose: "Test",
      affordabilityFlag: "FAIL" as const,
      monthlyInstalment: "100",
      pasqAcknowledged: true,
      affordabilityDeclared: true,
      recklessLendingConfirmed: false,
    }
    const errs = validateAllApplication(d, [PRODUCT], { forReview: true })
    expect(errs.recklessLendingConfirmed).toBe(
      "Acknowledge reckless-lending risk to proceed",
    )
  })

  it("forReview=true: surfaces both Step 1 errors AND Step 4 ack errors", () => {
    const d = {
      ...EMPTY_APPLICATION_WIZARD_DATA,
      clientId: "",
      productId: "p1",
      appliedAmount: "5000",
      appliedTermDays: "30",
      purpose: "Test",
      affordabilityFlag: "PASS" as const,
      monthlyInstalment: "100",
      pasqAcknowledged: false,
      affordabilityDeclared: false,
    }
    const errs = validateAllApplication(d, [PRODUCT], { forReview: true })
    expect(errs.clientId).toBeDefined()
    expect(errs.pasqAcknowledged).toBe("Confirm the client understands the PASQ will follow during review")
    expect(errs.affordabilityDeclared).toBe("Required to submit for review")
  })
})

describe("deriveAffordabilityFlag", () => {
  // Binary 70% NDI rule (matches legacy ApplicationForm).
  // MARGINAL is reserved in the enum but unreachable until credit-policy
  // sign-off — no test asserts it.
  it("returns PASS at NDI ratio 69.9", () => {
    expect(deriveAffordabilityFlag(69.9)).toBe("PASS")
  })
  it("returns PASS at the 70% boundary", () => {
    expect(deriveAffordabilityFlag(70)).toBe("PASS")
  })
  it("returns FAIL just above 70%", () => {
    expect(deriveAffordabilityFlag(70.1)).toBe("FAIL")
  })
  it("returns FAIL at 100", () => {
    expect(deriveAffordabilityFlag(100)).toBe("FAIL")
  })
  it("returns PASS at 0", () => {
    expect(deriveAffordabilityFlag(0)).toBe("PASS")
  })
  // Pins the documented precondition: this function does NOT defend against
  // negative input; callers must gate on ndi > 0 (see Step3Affordability.tsx).
  // A future "defensive" change here must update this test consciously.
  it("returns PASS for negative ndiPct (precondition violated — caller must gate)", () => {
    expect(deriveAffordabilityFlag(-1)).toBe("PASS")
  })
})

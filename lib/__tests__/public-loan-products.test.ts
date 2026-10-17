import { describe, it, expect } from "vitest"
import { PRODUCT_PRICING } from "../product-pricing"
import {
  QUALIFY_AMOUNT_MAX_RANDS,
  applyLivePricing,
  calculatePublicLoanQuote,
  getPublicLoanProduct,
  getTermDays,
  microMaxRands,
  qualifyAmountBoundsRands,
  qualifyTermWindow,
  qualifyTerm,
  productForAmount,
  applyProductLimitsRands,
  applyProductTermDays,
  applyTermError,
  planApplyTerm,
  effectiveApplyTermRange,
  serverTermRangeFromResponse,
  qualifyApplyHref,
  formatRandsWhole,
  formatProductRange,
  formatProductTermRange,
  formatRatePct,
  formatInterestLabel,
} from "../public-loan-products"
import type { LivePricing, PublicLoanProduct } from "../public-loan-products"

// Regression guard for public-quote money accuracy. A private, hardcoded marketing fee table (15% init / R1,207.50 cap /
// R69 service) drifts from the LoanProduct rows and UNDER-quotes some loans —
// telling a borrower a lower cost of credit than they would actually be charged.
//
// These tests pin PRODUCT_PRICING (now the single source of truth) to what the
// products CURRENTLY charge, and assert that the end-to-end public
// quote reproduces the real product's fee. If anyone silently reverts a fee/rate
// back toward the stale table, or the marketing quote drifts from the product
// again, this fails loudly.
//
// NCA note: the personal-loan initiation fee (16.5%) is under separate legal
// review. These tests assert what the product charges TODAY so the
// marketing quote matches origination; when legal changes the LoanProduct config,
// update PRODUCT_PRICING and these expectations together (see product-pricing.ts).

describe("PRODUCT_PRICING mirrors the live LoanProduct config", () => {
  it("personal loan: 16.5% init capped at R1,080, R69 service, 2.25%/mo reducing balance (NCA cap)", () => {
    expect(PRODUCT_PRICING.personal).toEqual({
      productType: "PERSONAL",
      interestRatePm: 0.0225,
      interestModel: "REDUCING_BALANCE",
      initiationFeeModel: "NCA_REG42",
      initiationFeePct: 0.165,
      initiationFeeMax: 108000, // R1,080 in cents
      monthlyServiceFee: 6900, // R69 in cents
    })
  })

  it("purchase-order funding: 2% init uncapped, no service, 2.25%/mo daily accrual (NCA cap)", () => {
    expect(PRODUCT_PRICING["purchase-order"]).toEqual({
      interestRatePm: 0.0225,
      interestModel: "DAILY_ACCRUAL",
      initiationFeeModel: "FLAT_PCT",
      initiationFeePct: 0.02,
      initiationFeeMax: 0, // uncapped
      monthlyServiceFee: 0,
    productType: "PO_FUNDING",
    })
  })

  it("short-term (30-Day Micro) loan: 15% init capped at R1,000, R69 service (R60+VAT), 5%/mo daily accrual (lockstep with prod MICRO30)", () => {
    expect(PRODUCT_PRICING["short-term"]).toEqual({
      productType: "MICRO",
      interestRatePm: 0.05,
      interestModel: "DAILY_ACCRUAL",
      initiationFeeModel: "NCA_REG42",
      initiationFeePct: 0.15,
      initiationFeeMax: 100000, // R1,000 in cents
      monthlyServiceFee: 6900, // R60 + VAT = R69, the NCA s.105 max (mirrors MICRO30)
    })
  })
})

describe("public marketing quote == the loan the customer is actually charged", () => {
  // The point is that the marketing quote equals what the customer is charged.
  // The FIGURES moved when the NCA Reg 42 initiation-fee ceiling was enforced in
  // calculateLoan (lib/loan/nca-fee-cap.ts): personal is consumer credit, so the
  // configured 16.5% is now clamped to the statutory maximum. The invariant is
  // asserted against that independent source, not against a restated constant.
  it("personal R5,000 / 12mo: initiation is the STATUTORY cap, not the configured 16.5%", () => {
    const quote = calculatePublicLoanQuote(getPublicLoanProduct("personal"), 500000, 12)
    // Independent literal, NOT ncaInitiationFeeCap(...) — an assertion derived
    // from the module under test agrees with it by construction and cannot
    // fail. Verified: mutating baseFeeExclVat left this file fully green.
    expect(quote.initiationFee).toBe(64975) // R649.75 = the Reg 42 ceiling
    expect(quote.initiationFee).toBeLessThan(82500) // 16.5% would have been R825
  })

  it("personal R8,000 / 12mo: the statutory cap binds before the product cap", () => {
    const quote = calculatePublicLoanQuote(getPublicLoanProduct("personal"), 800000, 12)
    expect(quote.initiationFee).toBe(99475) // R994.75 = the Reg 42 ceiling
    expect(quote.initiationFee).toBeLessThan(108000) // the product's own R1,080 cap
  })

  it("PO funding R500,000 / 4mo (120d): initiation R10,000 (2%, uncapped), NOT the old ~R8,792 under-quote", () => {
    // the stale 15%-cap-R1,207.50 table under-quoted initiation. PO is now
    // month-unit: 4 months = 120 days → interest R45,000 + init R10,000.
    const quote = calculatePublicLoanQuote(getPublicLoanProduct("purchase-order"), 50000000, 4)
    expect(quote.initiationFee).toBe(1000000) // R10,000 (2%, uncapped) — the point
    expect(quote.totalRepayable).toBe(55500000) // R555,000 (R500k + R45k interest @2.25%/mo over 4mo + R10k init)
  })

  it("short-term R2,000 / 30d: R69 service fee (R60+VAT), 15% init, total R2,469", () => {
    const quote = calculatePublicLoanQuote(getPublicLoanProduct("short-term"), 200000, 30)
    expect(quote.initiationFee).toBe(30000) // R300 (15%)
    expect(quote.serviceFees).toBe(6900) // R69 (R60 + VAT), now billed on the 30-day term
    // R2,000 + 5% interest R100 + init R300 + service R69 = R2,469
    expect(quote.totalRepayable).toBe(246900)
  })
})

describe("personal calculator surfaces the term, not an understated APR", () => {
  it("the tertiary metric is the loan term, and no APR figure is derived", () => {
    const quote = calculatePublicLoanQuote(getPublicLoanProduct("personal"), 1000000, 12)
    // the old (totalInterest / principal) * (365 / termDays) 'Est. APR'
    // understated the reducing-balance rate ~2x and was removed. The tertiary
    // metric is now simply the term.
    expect(quote.tertiaryMetric).toBe(quote.term)
    expect(quote.tertiaryMetric).toBe(12)
  })
})

describe("public amount ranges + terms mirror the prod LoanProduct config", () => {
  // "Marketing must conform to how the product is set up": the public ranges are
  // pinned to the active LoanProduct rows so the site never advertises an
  // amount/term the product can't originate. If a product's range changes in the
  // admin UI, update the catalogue AND these expectations together.
  it("personal loan: R2,000–R100,000 (cents), matching the prod PERSONAL LoanProduct", () => {
    const p = getPublicLoanProduct("personal")
    expect(p.minAmount).toBe(200000) // R2,000
    expect(p.maxAmount).toBe(10000000) // R100,000 (source of truth)
  })

  it("short-term loan: R500–R2,000, fixed 30-day term (= MICRO30), not R500–R8,000 / 7–90d", () => {
    const p = getPublicLoanProduct("short-term")
    expect(p.minAmount).toBe(50000) // R500
    expect(p.maxAmount).toBe(1000000) // R10,000
    expect(p.fixedTerm).toBe(30)
  })

  it("PO funding: R10,000–R500,000 over 1–4 months (= 30–120 days, now month-unit per #327)", () => {
    const p = getPublicLoanProduct("purchase-order")
    expect(p.minAmount).toBe(1000000) // R10,000
    expect(p.maxAmount).toBe(50000000) // R500,000
    expect(p.termUnit).toBe("months")
    expect(p.minTerm).toBe(1) // 30 days
    expect(p.maxTerm).toBe(4) // 120 days
  })

  it("qualify wizard amount ceiling tracks the personal max (R100,000)", () => {
    expect(QUALIFY_AMOUNT_MAX_RANDS).toBe(100000)
  })
})

describe("applyLivePricing (calculator overlays the live LoanProduct fee structure + ranges)", () => {
  it("overlays live fee structure AND amount/term ranges; curated metadata is untouched", () => {
    const merged = applyLivePricing({
      "short-term": {
        interestRatePm: 0.04,
        interestModel: "FLAT",
        initiationFeePct: 0.1,
        initiationFeeMax: 50000,
        monthlyServiceFee: 5000,
        minAmount: 40000, // R400
        maxAmount: 300000, // R3,000
        minTermDays: 7,
        maxTermDays: 60,
      },
    })
    const st = merged.find((p) => p.code === "short-term")!
    expect(st.monthlyServiceFee).toBe(5000) // live value overlaid
    expect(st.interestRatePm).toBe(0.04)
    expect(st.initiationFeeMax).toBe(50000)
    expect(st.minAmount).toBe(40000) // live range overlaid
    expect(st.maxAmount).toBe(300000)
    expect(st.minTerm).toBe(7) // termUnit "days" → days pass through
    expect(st.maxTerm).toBe(60)
    expect(st.fixedTerm).toBeUndefined() // min != max → term slider shown
    expect(st.label).toBe("Short-term loan") // static marketing metadata preserved
  })

  it("derives a fixed term when the live range collapses (min == max), and converts months", () => {
    const merged = applyLivePricing({
      "short-term": {
        interestRatePm: 0.05, interestModel: "DAILY_ACCRUAL",
        initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 6900,
        minAmount: 50000, maxAmount: 1000000, minTermDays: 30, maxTermDays: 30,
      },
      personal: {
        interestRatePm: 0.03, interestModel: "REDUCING_BALANCE",
        initiationFeePct: 0.165, initiationFeeMax: 108000, monthlyServiceFee: 6900,
        minAmount: 500000, maxAmount: 1000000, minTermDays: 90, maxTermDays: 1800,
      },
    })
    const st = merged.find((p) => p.code === "short-term")!
    expect(st.fixedTerm).toBe(30) // min == max (days) → fixed
    // personal termUnit is "months": 90d → 3, 1800d → 60
    const pl = merged.find((p) => p.code === "personal")!
    expect(pl.minTerm).toBe(3)
    expect(pl.maxTerm).toBe(60)
    expect(pl.fixedTerm).toBeUndefined()
  })

  it("rounds a month-unit range INWARD so the offered term never exceeds the real day range", () => {
    // personal is termUnit "months"; admin day inputs need not be 30-multiples.
    const merged = applyLivePricing({
      personal: {
        interestRatePm: 0.03, interestModel: "REDUCING_BALANCE",
        initiationFeePct: 0.165, initiationFeeMax: 108000, monthlyServiceFee: 6900,
        minAmount: 500000, maxAmount: 1000000, minTermDays: 100, maxTermDays: 200,
      },
    })
    const pl = merged.find((p) => p.code === "personal")!
    expect(pl.minTerm).toBe(4) // ceil(100/30) — 120d ≥ 100, never below the real min
    expect(pl.maxTerm).toBe(6) // floor(200/30) — 180d ≤ 200, never above the real max
    expect(getTermDays(pl, pl.minTerm)).toBeGreaterThanOrEqual(100)
    expect(getTermDays(pl, pl.maxTerm)).toBeLessThanOrEqual(200)
  })

  it("keeps the static snapshot for products with no live entry (safe fallback on empty/failed fetch)", () => {
    const merged = applyLivePricing({})
    expect(merged.find((p) => p.code === "short-term")!.monthlyServiceFee).toBe(6900)
  })
})

describe("live-aware qualify bounds (qualify wizard tracks the live ranges)", () => {
  const personalRange = (minAmount: number, maxAmount: number): LivePricing => ({
    interestRatePm: 0.03,
    interestModel: "REDUCING_BALANCE",
    initiationFeePct: 0.165,
    initiationFeeMax: 108000,
    monthlyServiceFee: 6900,
    minAmount,
    maxAmount,
    minTermDays: 90,
    maxTermDays: 1800,
  })
  const shortTermRange = (minAmount: number, maxAmount: number): LivePricing => ({
    interestRatePm: 0.05,
    interestModel: "FLAT",
    initiationFeePct: 0.15,
    initiationFeeMax: 100000,
    monthlyServiceFee: 6900,
    minAmount,
    maxAmount,
    minTermDays: 30,
    maxTermDays: 30,
  })

  it("fail-open: an empty overlay yields the static bounds (R500 / R100,000) and micro boundary (R10,000)", () => {
    const products = applyLivePricing({})
    expect(qualifyAmountBoundsRands(products)).toEqual({ min: 500, max: 100000 })
    expect(microMaxRands(products)).toBe(10000)
    // and matches the static constant the rest of the app still exports
    expect(qualifyAmountBoundsRands(products).max).toBe(QUALIFY_AMOUNT_MAX_RANDS)
  })

  it("ceiling tracks the live personal max, micro boundary tracks the live short-term max", () => {
    const products = applyLivePricing({
      personal: personalRange(200000, 25000000), // R2,000 – R250,000
      "short-term": shortTermRange(50000, 800000), // R500 – R8,000
    })
    expect(qualifyAmountBoundsRands(products).max).toBe(250000)
    expect(microMaxRands(products)).toBe(8000)
  })

  it("min tracks the smallest live product entry point", () => {
    const products = applyLivePricing({
      "short-term": shortTermRange(30000, 1000000), // R300 — below the static R500 floor
    })
    expect(qualifyAmountBoundsRands(products).min).toBe(300)
  })
})

describe("qualifyTermWindow — the wizard's DISPLAY window per tier (term itself is canonical days)", () => {
  it("exposes the micro day-window and personal month-window", () => {
    expect(qualifyTermWindow(true)).toEqual({ min: 7, max: 30, unit: "days" })
    expect(qualifyTermWindow(false)).toEqual({ min: 3, max: 60, unit: "months" })
  })
})

describe("qualifyTerm — canonical-days ↔ display conversion + clamp (term-unit follow-up)", () => {
  it("micro: days ARE the display value, clamped to [7,30]", () => {
    expect(qualifyTerm(20, true)).toEqual({ display: 20, days: 20 })
    expect(qualifyTerm(4, true)).toEqual({ display: 7, days: 7 }) // below min
    expect(qualifyTerm(45, true)).toEqual({ display: 30, days: 30 }) // above max
  })

  it("personal: days→months for display, back to days for state, clamped to [3,60]", () => {
    expect(qualifyTerm(360, false)).toEqual({ display: 12, days: 360 }) // 12 months
    expect(qualifyTerm(1800, false)).toEqual({ display: 60, days: 1800 }) // 60 months (max)
  })

  it("FLIP micro→personal: a 7-day term re-displayed as personal → 3 months (90 days), NOT 7 months", () => {
    // The canonical-days replacement for the old reconcileQualifyTerm flip guard:
    // 7 days seen as personal = round(7/30)=0 → clamped up to the 3-month minimum.
    expect(qualifyTerm(7, false)).toEqual({ display: 3, days: 90 })
    expect(qualifyTerm(30, false)).toEqual({ display: 3, days: 90 }) // 1mo → 3mo min
  })

  it("FLIP personal→micro: a 450-day (15-month) term re-displayed as micro → clamped to 30 days", () => {
    expect(qualifyTerm(450, true)).toEqual({ display: 30, days: 30 })
  })

  it("non-finite → the window minimum for the tier", () => {
    expect(qualifyTerm(Number.NaN, true)).toEqual({ display: 7, days: 7 })
    expect(qualifyTerm(Number.NaN, false)).toEqual({ display: 3, days: 90 })
  })
})

describe("productForAmount — the ONE shared amount→product tiering rule", () => {
  const fee = (extra: Partial<LivePricing>): LivePricing => ({
    interestRatePm: 0.05,
    interestModel: "FLAT",
    initiationFeePct: 0.15,
    initiationFeeMax: 100000,
    monthlyServiceFee: 6900,
    minAmount: 50000,
    maxAmount: 1000000,
    minTermDays: 30,
    maxTermDays: 30,
    ...extra,
  })

  it("empty overlay (static): boundaries are short-term max R10,000 and personal max R100,000", () => {
    const p = applyLivePricing({})
    expect(productForAmount(0, p)).toBe("")
    expect(productForAmount(-5, p)).toBe("")
    expect(productForAmount(Number.NaN, p)).toBe("")
    expect(productForAmount(500, p)).toBe("MICRO")
    expect(productForAmount(10000, p)).toBe("MICRO") // boundary inclusive
    expect(productForAmount(10001, p)).toBe("PERSONAL")
    expect(productForAmount(100000, p)).toBe("PERSONAL") // boundary inclusive
    expect(productForAmount(100001, p)).toBe("PO_FUNDING")
    expect(productForAmount(500000, p)).toBe("PO_FUNDING")
  })

  it("in the short-term↔personal OVERLAP zone, the smaller product wins (micro)", () => {
    // static short-term R500–R10,000 and personal R2,000–R100,000 overlap R2k–R10k;
    // an amount in the overlap routes to MICRO (≤ short-term max), matching the
    // wizard's isMicro so the two surfaces agree.
    const p = applyLivePricing({})
    expect(productForAmount(5000, p)).toBe("MICRO")
    expect(productForAmount(2000, p)).toBe("MICRO")
  })

  it("tracks live boundaries: short-term max R2,000 → R5,000 is PERSONAL (staging config)", () => {
    // A config where short-term is maxed at R2,000, personal min R5,000.
    const p = applyLivePricing({
      "short-term": fee({ minAmount: 50000, maxAmount: 200000 }), // R500–R2,000
      personal: fee({
        interestModel: "REDUCING_BALANCE",
        minAmount: 500000, // R5,000
        maxAmount: 10000000, // R100,000
      }),
    })
    expect(productForAmount(2000, p)).toBe("MICRO")
    expect(productForAmount(2001, p)).toBe("PERSONAL")
    expect(productForAmount(5000, p)).toBe("PERSONAL")
  })

  it("GAP zone + clamp guardrail: an amount below the routed product's min is clamped up, never dead-banded", () => {
    // This config opens a gap R2,001–R4,999 (above short-term max R2,000, below personal
    // min R5,000). productForAmount routes it to PERSONAL; the caller clamps it into
    // PERSONAL's [min,max] so it lands at R5,000 rather than being rejected.
    const p = applyLivePricing({
      "short-term": fee({ minAmount: 50000, maxAmount: 200000 }),
      personal: fee({ interestModel: "REDUCING_BALANCE", minAmount: 500000, maxAmount: 10000000 }),
    })
    const type = productForAmount(3000, p)
    expect(type).toBe("PERSONAL")
    const [min, max] = applyProductLimitsRands(p)[type as "PERSONAL"]
    const clamped = Math.max(min, Math.min(max, 3000))
    expect(clamped).toBe(5000) // clamped up to personal min — no dead band
  })

  it("disabled/missing product falls back to the static boundary", () => {
    // active:false → the live read omits short-term → applyLivePricing keeps the
    // static short-term (R10,000 max), so the micro boundary stays static.
    const p = applyLivePricing({
      personal: fee({ interestModel: "REDUCING_BALANCE", minAmount: 200000, maxAmount: 10000000 }),
    })
    expect(microMaxRands(p)).toBe(10000) // static short-term max
    expect(productForAmount(9000, p)).toBe("MICRO") // classified by the static R10k boundary
  })
})

describe("applyProductLimitsRands — apply slider bounds from live products", () => {
  it("empty overlay → the static apply limits (rands)", () => {
    expect(applyProductLimitsRands(applyLivePricing({}))).toEqual({
      MICRO: [500, 10000],
      PERSONAL: [2000, 100000],
      PO_FUNDING: [10000, 500000],
    })
  })

  it("overlays live ranges per apply product (MICRO←short-term, PERSONAL←personal, PO←purchase-order)", () => {
    const products: PublicLoanProduct[] = applyLivePricing({
      "short-term": {
        interestRatePm: 0.05, interestModel: "FLAT",
        initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 6900,
        minAmount: 50000, maxAmount: 200000, minTermDays: 30, maxTermDays: 30, // R500–R2,000
      },
      "purchase-order": {
        interestRatePm: 0.025, interestModel: "DAILY_ACCRUAL",
        initiationFeePct: 0.02, initiationFeeMax: 0, monthlyServiceFee: 0,
        minAmount: 2000000, maxAmount: 100000000, minTermDays: 30, maxTermDays: 120, // R20,000–R1,000,000
      },
    })
    const limits = applyProductLimitsRands(products)
    expect(limits.MICRO).toEqual([500, 2000]) // live short-term
    expect(limits.PO_FUNDING).toEqual([20000, 1000000]) // live purchase-order
    expect(limits.PERSONAL).toEqual([2000, 100000]) // no live entry → static
  })
})

describe("qualifyApplyHref — the apply handoff classifies the amount it carries", () => {
  // Config: short-term R500–R2,000, personal R5,000–R100,000.
  const staging = () =>
    applyLivePricing({
      "short-term": {
        interestRatePm: 0.05, interestModel: "FLAT",
        initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0,
        minAmount: 50000, maxAmount: 200000, minTermDays: 30, maxTermDays: 30,
      },
      personal: {
        interestRatePm: 0.03, interestModel: "REDUCING_BALANCE",
        initiationFeePct: 0.165, initiationFeeMax: 108000, monthlyServiceFee: 6900,
        minAmount: 500000, maxAmount: 10000000, minTermDays: 90, maxTermDays: 1800,
      },
    })

  it("a micro amount → product=short-term; term (canonical days) passes through", () => {
    const href = qualifyApplyHref(200000, 20, staging()) // R2,000, 20 days
    expect(href).toContain("amount=200000")
    expect(href).toContain("product=short-term")
    expect(href).toContain("term=20")
  })

  it("a personal amount → product=personal; term (canonical days) passes through", () => {
    const href = qualifyApplyHref(500000, 360, staging()) // R5,000, 360 days (= 12 months)
    expect(href).toContain("product=personal")
    expect(href).toContain("term=360")
  })

  it("a suggested micro amount from a personal request → short-term (classified by ITS amount)", () => {
    // findMaxAffordable can suggest R2,000 (micro) for a personal request carrying
    // 360 days. The href must route to short-term for THAT amount (using the original
    // tier would apply the customer under the wrong product). The term is canonical
    // DAYS so it passes straight through — no unit reinterpretation — and the apply
    // route clamps it into the short-term product's own range.
    const href = qualifyApplyHref(200000, 360, staging())
    expect(href).toContain("product=short-term")
    expect(href).not.toContain("product=personal")
    expect(href).toContain("term=360") // days pass through unambiguously
  })
})

describe("marketing-copy formatters", () => {
  it("formatRandsWhole: whole rands, comma-grouped, no decimals (cents in)", () => {
    expect(formatRandsWhole(50000)).toBe("R500")
    expect(formatRandsWhole(200000)).toBe("R2,000")
    expect(formatRandsWhole(10000000)).toBe("R100,000")
    expect(formatRandsWhole(0)).toBe("R0")
  })

  it("formatRatePct: monthly rate as a percent, trimming trailing zeros", () => {
    expect(formatRatePct(0.05)).toBe("5%")
    expect(formatRatePct(0.03)).toBe("3%")
    expect(formatRatePct(0.025)).toBe("2.5%")
    expect(formatRatePct(0.165)).toBe("16.5%")
  })

  it("formatInterestLabel: shared interest wording per model (fee table + qualify wizard)", () => {
    expect(formatInterestLabel(getPublicLoanProduct("short-term"))).toBe("5%/mo daily accrual")
    expect(formatInterestLabel(getPublicLoanProduct("personal"))).toBe("2.25%/mo reducing")
    expect(formatInterestLabel(getPublicLoanProduct("purchase-order"))).toBe("2.25%/mo daily accrual")
  })

  it("short-term calculator-card model label matches the DAILY_ACCRUAL row wording", () => {
    expect(getPublicLoanProduct("short-term").modelLabel).toBe("Short-term daily rate")
  })

  it("formatProductRange: amount range from live cents (default en-dash, overridable sep)", () => {
    const shortTerm = getPublicLoanProduct("short-term") // R500–R10,000 static
    expect(formatProductRange(shortTerm, " - ")).toBe("R500 - R10,000")
    expect(formatProductRange(getPublicLoanProduct("personal"), "–")).toBe("R2,000–R100,000")
  })

  it("formatProductTermRange: fixed term collapses; a range shows both ends", () => {
    expect(formatProductTermRange(getPublicLoanProduct("short-term"))).toBe("30 days") // fixed
    expect(formatProductTermRange(getPublicLoanProduct("personal"), " - ")).toBe("3 - 60 months")
  })

  it("formatters track a live overlay (a rate/range change flows through)", () => {
    const [personal] = applyLivePricing({
      personal: {
        interestRatePm: 0.028, interestModel: "REDUCING_BALANCE",
        initiationFeePct: 0.165, initiationFeeMax: 108000, monthlyServiceFee: 6900,
        minAmount: 500000, maxAmount: 25000000, minTermDays: 90, maxTermDays: 1800,
      },
    }).filter((p) => p.code === "personal")
    expect(formatProductRange(personal, "–")).toBe("R5,000–R250,000")
    expect(formatRatePct(personal.interestRatePm)).toBe("2.8%")
    // Period decimal, NOT the en-ZA comma ("2,8") — every public page renders a
    // fractional admin-set rate through this one helper so they can't diverge.
    expect(formatInterestLabel(personal)).toBe("2.8%/mo reducing")
  })
})

describe("applyProductTermDays / applyTermError — apply form term requirement", () => {
  it("static catalogue: short-term is fixed at 30 days; personal and PO are ranges in days", () => {
    expect(applyProductTermDays(applyLivePricing({}))).toEqual({
      MICRO: { min: 30, max: 30, fixed: true },
      PERSONAL: { min: 90, max: 1800, fixed: false },
      PO_FUNDING: expect.objectContaining({ fixed: false }),
    })
  })

  it("rejects an empty, non-numeric, fractional, zero or negative term", () => {
    const range = { min: 90, max: 1800 }
    for (const bad of ["", "  ", "abc", "30.5", "0", "-5"]) {
      expect(applyTermError(bad, range), bad).toBe("Please enter your loan term in days")
    }
  })

  it("rejects a term outside the product range and accepts one inside it", () => {
    const range = { min: 90, max: 1800 }
    expect(applyTermError("89", range)).toBe("Term must be between 90 and 1800 days")
    expect(applyTermError("1801", range)).toBe("Term must be between 90 and 1800 days")
    expect(applyTermError("90", range)).toBeNull()
    expect(applyTermError("360", range)).toBeNull()
  })
})

describe("planApplyTerm — the apply form never sends no term where one may be required", () => {
  const variable = { min: 90, max: 1800, fixed: false }
  const fixed = { min: 30, max: 30, fixed: true }

  it("variable product: field shown, blank or bad input is an error and nothing valid is sent", () => {
    expect(planApplyTerm("", variable)).toEqual({ showField: true, error: "Please enter your loan term in days", sendTermDays: "" })
    expect(planApplyTerm("abc", variable).error).not.toBeNull()
    expect(planApplyTerm("30", variable).error).toBe("Term must be between 90 and 1800 days")
  })

  it("variable product: a valid term shows no error and is sent as typed", () => {
    expect(planApplyTerm(" 180 ", variable)).toEqual({ showField: true, error: null, sendTermDays: "180" })
  })

  it("catalogue-fixed product: field hidden, no error, the fixed term is sent even if the draft term is blank or stale", () => {
    expect(planApplyTerm("", fixed)).toEqual({ showField: false, error: null, sendTermDays: "30" })
    expect(planApplyTerm("7", fixed).sendTermDays).toBe("30")
  })

  it("unknown product/range (e.g. a restored draft with an unrecognised product): field shown, required, no crash", () => {
    expect(planApplyTerm("", undefined)).toEqual({ showField: true, error: "Please enter your loan term in days", sendTermDays: "" })
    expect(planApplyTerm("45", undefined)).toEqual({ showField: true, error: null, sendTermDays: "45" })
  })
})

describe("server-guided apply term range", () => {
  const body = { success: false, error: "msg", termRange: { minTermDays: 60, maxTermDays: 90 } }

  it("reads the range from the route's 400 body, tagged with the product", () => {
    expect(serverTermRangeFromResponse("MICRO", body)).toEqual({ productType: "MICRO", min: 60, max: 90 })
  })

  it.each([null, {}, { termRange: {} }, { termRange: { minTermDays: "60", maxTermDays: 90 } }, { termRange: { minTermDays: 90, maxTermDays: 60 } }])(
    "ignores a response without a usable range: %j",
    (data) => {
      expect(serverTermRangeFromResponse("MICRO", data)).toBeNull()
    },
  )

  it("a catalogue-fixed product becomes a visible field with the server's bounds", () => {
    const fixed = { min: 30, max: 30, fixed: true }
    const server = serverTermRangeFromResponse("MICRO", body)
    const range = effectiveApplyTermRange("MICRO", fixed, server)
    expect(range).toEqual({ min: 60, max: 90, fixed: false })
    expect(planApplyTerm("", range)).toMatchObject({ showField: true, error: "Please enter your loan term in days" })
    expect(planApplyTerm("30", range).error).toBe("Term must be between 60 and 90 days")
    expect(planApplyTerm("75", range)).toEqual({ showField: true, error: null, sendTermDays: "75" })
  })

  it("a server range for another product does not apply", () => {
    const fixed = { min: 30, max: 30, fixed: true }
    expect(effectiveApplyTermRange("PERSONAL", fixed, { productType: "MICRO", min: 60, max: 90 })).toBe(fixed)
    expect(effectiveApplyTermRange("MICRO", fixed, null)).toBe(fixed)
  })
})

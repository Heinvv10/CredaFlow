import { calculateLoan } from "@/lib/loan-calculator"
import type { LoanCalcInput, LoanCalcResult } from "@/lib/loan-calculator"
import { PRODUCT_PRICING } from "@/lib/product-pricing"

export type PublicLoanProductCode =
  | "short-term"
  | "personal"
  | "purchase-order"
  | "invoice-discounting"

export type PublicLoanProduct = {
  code: PublicLoanProductCode
  label: string
  shortLabel: string
  description: string
  amountLabel: string
  minAmount: number
  maxAmount: number
  amountStep: number
  defaultAmount: number
  amountOptions?: number[]
  minTerm: number
  maxTerm: number
  defaultTerm: number
  fixedTerm?: number
  termUnit: "days" | "months"
  modelLabel: string
  interestModel: LoanCalcInput["interestModel"]
  /** LoanProduct.productType — selects the NCA initiation-fee regime.
   *  Optional: absent means consumer credit, the capped (safe) default. */
  productType?: LoanCalcInput["productType"]
  interestRatePm: number
  /** LoanProduct.initiationFeeModel — whether the fee is priced on the Reg 42
   *  schedule (so the published and charged figures agree) or on a flat pct. */
  initiationFeeModel: LoanCalcInput["initiationFeeModel"]
  initiationFeePct: number
  initiationFeeMax: number
  monthlyServiceFee: number
  primaryMetricLabel: string
  secondaryMetricLabel: string
  tertiaryMetricLabel: string
  applyProduct: string
  desktopHref: string
  mobileHref: string
  desktopCta: string
  mobileCta: string
  note: string
}

export type PublicLoanQuote = {
  product: PublicLoanProduct
  amount: number
  term: number
  termDays: number
  totalInterest: number
  initiationFee: number
  serviceFees: number
  totalRepayable: number
  monthlyInstalment: number
  disbursementAmount: number
  primaryMetric: number
  secondaryMetric: number
  tertiaryMetric: number
  schedule: LoanCalcResult["schedule"]
}

// Amount ranges + terms below MIRROR the active LoanProduct rows so
// the marketing calculators/apply form never advertise an amount or term the
// product can't originate (extends the W-2 single-source principle to ranges):
//   Short-term/MICRO30 R500–R10,000    · 30-day fixed
//   Personal           R2,000–R100,000 · 3–60 months
//   PO funding        R10,000–R500,000 · 1–4 months (30–120 days, shown in months)
// Keep these in lockstep with the LoanProduct config (admin UI) — a widened
// product must be reflected here, and vice versa.
export const publicLoanProducts: PublicLoanProduct[] = [
  {
    code: "short-term",
    label: "Short-term loan",
    shortLabel: "Short-term",
    description: "Smaller short-term cashflow support with a simple total-repayable estimate.",
    amountLabel: "Loan amount",
    minAmount: 50000,
    maxAmount: 1000000,
    amountStep: 50000,
    defaultAmount: 100000,
    minTerm: 30,
    maxTerm: 30,
    defaultTerm: 30,
    fixedTerm: 30,
    termUnit: "days",
    modelLabel: "Short-term daily rate",
    ...PRODUCT_PRICING["short-term"],
    primaryMetricLabel: "Total repayable",
    secondaryMetricLabel: "Estimated cost",
    tertiaryMetricLabel: "Term",
    applyProduct: "short-term",
    desktopHref: "/site/apply",
    mobileHref: "/site/apply",
    desktopCta: "Apply for short-term loan",
    mobileCta: "Apply for short-term loan",
    note: "Indicative only; approval and final pricing depend on the affordability assessment.",
  },
  {
    code: "personal",
    label: "Personal loan",
    shortLabel: "Personal",
    description: "Monthly repayment loan for larger personal needs, shown in client-friendly months.",
    amountLabel: "Loan amount",
    minAmount: 200000,
    maxAmount: 10000000,
    amountStep: 50000,
    defaultAmount: 500000,
    minTerm: 3,
    maxTerm: 60,
    defaultTerm: 12,
    termUnit: "months",
    modelLabel: "Reducing-balance instalments",
    ...PRODUCT_PRICING["personal"],
    primaryMetricLabel: "Monthly estimate",
    secondaryMetricLabel: "Total repayable",
    tertiaryMetricLabel: "Term",
    applyProduct: "personal",
    desktopHref: "/site/apply",
    mobileHref: "/site/apply",
    desktopCta: "Apply for personal loan",
    mobileCta: "Apply for personal loan",
    note: "Monthly estimate excludes any final changes after verification and affordability checks.",
  },
  {
    code: "purchase-order",
    label: "Purchase order funding",
    shortLabel: "PO funding",
    description: "Business funding linked to verified purchase orders and repayment at maturity.",
    amountLabel: "Funding amount",
    minAmount: 1000000,
    maxAmount: 50000000,
    amountStep: 500000,
    defaultAmount: 2500000,
    // PO funding runs 30–120 days in the DB; presented to clients in whole
    // months (1–4). applyLivePricing converts the live day-range to months
    // (ceil min / floor max) and getTermDays converts back (× 30) so the apply
    // link and the booked loan still carry exact days.
    minTerm: 1,
    maxTerm: 4,
    defaultTerm: 2,
    termUnit: "months",
    modelLabel: "Daily accrual to maturity",
    ...PRODUCT_PRICING["purchase-order"],
    primaryMetricLabel: "Repayment at maturity",
    secondaryMetricLabel: "Estimated cost",
    tertiaryMetricLabel: "Term",
    applyProduct: "capital",
    desktopHref: "/site/apply",
    mobileHref: "/site/apply",
    desktopCta: "Start PO funding enquiry",
    mobileCta: "Start PO funding enquiry",
    note: "Designed for verified business orders; final advance terms depend on document review.",
  },
  {
    code: "invoice-discounting",
    label: "Invoice discounting",
    shortLabel: "Invoice",
    description: "Unlock cash tied up in approved unpaid invoices while waiting for debtor payment.",
    amountLabel: "Invoice advance",
    minAmount: 500000,
    maxAmount: 50000000,
    amountStep: 500000,
    defaultAmount: 2000000,
    minTerm: 7,
    maxTerm: 90,
    defaultTerm: 30,
    termUnit: "days",
    modelLabel: "Invoice advance estimate",
    ...PRODUCT_PRICING["invoice-discounting"],
    primaryMetricLabel: "Repayment at maturity",
    secondaryMetricLabel: "Estimated cost",
    tertiaryMetricLabel: "Term",
    applyProduct: "invoice-discounting",
    desktopHref: "/site/apply",
    mobileHref: "/site/apply",
    desktopCta: "Start invoice enquiry",
    mobileCta: "Start invoice enquiry",
    note: "Estimate assumes a verified invoice and debtor review before any offer is made.",
  },
]

export function getPublicLoanProduct(code: PublicLoanProductCode) {
  return publicLoanProducts.find((product) => product.code === code) ?? publicLoanProducts[0]
}

// Map each public marketing card to the real LoanProduct.code in the DB, so the
// calculator can overlay the LIVE fee structure the admin sets at
// /settings/products/loan (Phase 2 — "the frontend shows what the backend has").
// invoice-discounting has no live product → it keeps the static indicative pricing.
export const LOAN_PRODUCT_DB_CODE: Partial<Record<PublicLoanProductCode, string>> = {
  "short-term": "MICRO30",
  personal: "PERSONAL",
  "purchase-order": "POFUND",
}

// The subset of a product that is genuinely "fee structure" — the fields the
// live LoanProduct row owns. Everything else (labels, ranges, CTAs, metric
// labels) stays curated marketing metadata.
// The live fields the backend LoanProduct row owns: the fee structure PLUS the
// amount and term ranges. minAmount/maxAmount are cents (same unit as
// PublicLoanProduct); the term arrives as raw DAYS and is converted to the
// product's termUnit on overlay.
export type LivePricing = {
  interestRatePm: number
  interestModel: PublicLoanProduct["interestModel"]
  /** Optional: absent is treated as consumer credit (the capped, safe default). */
  productType?: PublicLoanProduct["productType"]
  /** Optional: absent keeps the static snapshot's model rather than clobbering
   *  it to the flat default, the same trap productType hit. */
  initiationFeeModel?: PublicLoanProduct["initiationFeeModel"]
  initiationFeePct: number
  initiationFeeMax: number
  monthlyServiceFee: number
  minAmount: number
  maxAmount: number
  minTermDays: number
  maxTermDays: number
}

// Overlay live per-product config (keyed by PUBLIC code) onto the static
// catalogue. A missing/unknown code keeps its static snapshot — which is held in
// lockstep with the DB — so this is safe when the live fetch is empty or fails.
// Fee structure + amount/term ranges come from the DB; curated marketing
// metadata (labels, descriptions, CTAs, step, defaults) stays static.
export function applyLivePricing(
  configByCode: Partial<Record<PublicLoanProductCode, LivePricing>>,
): PublicLoanProduct[] {
  return publicLoanProducts.map((product) => {
    const live = configByCode[product.code]
    if (!live) return product
    // Term is stored in DAYS; present it in the product's termUnit. For a
    // month-unit product round INWARD — ceil the min, floor the max — so every
    // selectable month (× 30 days) stays inside the real day range and is never
    // rejected at apply time. When a narrow, non-month-aligned range makes
    // ceil(min) > floor(max) (no whole month fits), clamp the MIN down to the
    // max rather than the max up to the min: it is safe to under-offer a term,
    // but advertising a term the product can't originate breaks the W-2 rule.
    const maxTerm = product.termUnit === "months"
      ? Math.max(1, Math.floor(live.maxTermDays / 30))
      : live.maxTermDays
    const minTerm = product.termUnit === "months"
      ? Math.min(Math.ceil(live.minTermDays / 30), maxTerm)
      : live.minTermDays
    // A single fixed term (min == max) hides the term slider; a real range shows it.
    const fixedTerm = live.minTermDays === live.maxTermDays ? minTerm : undefined
    // Keep only quick-select amounts that fall inside the live range.
    const options = product.amountOptions?.filter((o) => o >= live.minAmount && o <= live.maxAmount)
    return {
      ...product,
      interestRatePm: live.interestRatePm,
      interestModel: live.interestModel,
      // Never let an overlay that omits the category CLOBBER the static one:
      // the server twin used to select no productType, so every server-rendered
      // pricing page silently lost the PO_FUNDING fee-cap exemption.
      productType: live.productType ?? product.productType,
      initiationFeeModel: live.initiationFeeModel ?? product.initiationFeeModel,
      initiationFeePct: live.initiationFeePct,
      initiationFeeMax: live.initiationFeeMax,
      monthlyServiceFee: live.monthlyServiceFee,
      minAmount: live.minAmount,
      maxAmount: live.maxAmount,
      minTerm,
      maxTerm,
      fixedTerm,
      amountOptions: options && options.length ? options : undefined,
    }
  })
}

/**
 * Consumer pre-qualification amount bounds in RANDS, derived from the product
 * catalogue so the qualify wizard's slider can never disagree with what the
 * products actually offer (audit H3). Min = the smallest product entry point;
 * max = the personal-loan ceiling (R100,000).
 */
export const QUALIFY_AMOUNT_MIN_RANDS = Math.round(
  Math.min(...publicLoanProducts.map((product) => product.minAmount)) / 100,
)
export const QUALIFY_AMOUNT_MAX_RANDS = Math.round(
  getPublicLoanProduct("personal").maxAmount / 100,
)

// LIVE-aware versions of the two constants above: same derivation, but computed
// from the (optionally live-overlaid) catalogue passed in — so the qualify
// wizard's slider tracks whatever the admin configured, not a frozen snapshot.
// Pass applyLivePricing(pricing); when pricing is empty/failed the catalogue IS
// the static snapshot, so these return the static QUALIFY_AMOUNT_* figures
// (fail-open). Returned in RANDS (catalogue amounts are cents ÷ 100).
export function qualifyAmountBoundsRands(products: PublicLoanProduct[]): { min: number; max: number } {
  const min = Math.round(Math.min(...products.map((product) => product.minAmount)) / 100)
  const personal = products.find((product) => product.code === "personal") ?? getPublicLoanProduct("personal")
  return { min, max: Math.round(personal.maxAmount / 100) }
}

// The micro↔personal boundary (RANDS) used by the qualify wizard to pick the
// term UNIT (≤ boundary = short-term, days; above = personal, months) and its
// fee structure. Derived from the short-term product's live maxAmount so an
// admin range change moves the boundary with no code change (Phase 0 rule A).
// Phase 2 folds this into the shared productForAmount() helper. Fail-open: an
// empty/failed overlay leaves the static short-term max (R10,000).
export function microMaxRands(products: PublicLoanProduct[]): number {
  const shortTerm = products.find((product) => product.code === "short-term") ?? getPublicLoanProduct("short-term")
  return Math.round(shortTerm.maxAmount / 100)
}

// The qualify wizard's term slider window, per micro/personal classification.
// Micro is a short (7–30 day) pre-qual exploration window; personal is 3–60
// months. These are wizard UX ranges, deliberately NOT the product's own term
// (the short-term product is a fixed 30-day loan) — the wizard lets the user
// explore, and the booked loan's term is set later by the product.
// The qualify wizard stores its term CANONICALLY in DAYS; this window is only for
// DISPLAY (converting days ↔ the tier's unit and clamping). Because the stored
// value is unit-unambiguous, a micro↔personal flip needs no reconciliation — the
// component just re-displays the same days in the new unit and clamps.
export function qualifyTermWindow(isMicro: boolean): { min: number; max: number; unit: "days" | "months" } {
  return isMicro ? { min: 7, max: 30, unit: "days" } : { min: 3, max: 60, unit: "months" }
}

// Convert a canonical-DAYS term into the current tier's DISPLAY value (days for
// micro, months = days/30 for personal), clamped into the tier's window — and back
// to the committed canonical days. Because the input is unit-unambiguous, a flip is
// handled purely by this convert-then-clamp: a 7-day micro term seen as personal
// becomes round(7/30)=0 → clamped up to the 3-month min → 90 days; a 450-day (15mo)
// personal term seen as micro becomes clamp(450, 7, 30)=30 days. `display` drives
// the slider/label; `days` is what to commit to state. Non-finite → the window min.
export function qualifyTerm(days: number, isMicro: boolean): { display: number; days: number } {
  const { min, max } = qualifyTermWindow(isMicro)
  const raw = Number.isFinite(days) ? (isMicro ? Math.round(days) : Math.round(days / 30)) : min
  const display = Math.max(min, Math.min(max, raw))
  return { display, days: isMicro ? display : display * 30 }
}

// ── Amount → product tiering (Phase 2: one rule for apply + qualify) ──────────

// The apply form's three loan product types.
export type ApplyProductType = "MICRO" | "PERSONAL" | "PO_FUNDING"

// Apply product type → public catalogue code. MICRO ← the R500–R10,000 short-term
// /MICRO30 product; PERSONAL ←
// personal; PO_FUNDING ← purchase-order. (Moved from apply/page.tsx so the apply
// form and the tiering helper share ONE definition.)
export const APPLY_PRODUCT_PUBLIC_CODE: Record<ApplyProductType, PublicLoanProductCode> = {
  MICRO: "short-term",
  PERSONAL: "personal",
  PO_FUNDING: "purchase-order",
}

// THE single amount→product tiering rule, shared by the apply form's routing and
// the qualify wizard's micro/personal split so they can never disagree again
// (Phase 0 rule A). Boundaries derive from each product's LIVE maxAmount — reusing
// the same single-sourced helpers the wizard uses — so an admin range change moves
// them with no code deploy: ≤ short-term.maxAmount → MICRO; ≤ personal.maxAmount →
// PERSONAL; else PO_FUNDING. Fail-open to the static catalogue. Returns "" for a
// non-positive amount (mirrors the old productFromAmount).
//
// The CALLER must clamp the amount into the chosen product's [min,max] (see
// applyProductLimitsRands / the apply slider clamp) — so if an admin ever opens a
// gap (one product's min above the previous product's max), an amount in that gap
// is pulled to the chosen product's min instead of routing to a product that then
// rejects it. This is the dead-band guardrail from the Phase 0 decision.
export function productForAmount(amountRands: number, products: PublicLoanProduct[]): ApplyProductType | "" {
  if (!Number.isFinite(amountRands) || amountRands <= 0) return ""
  if (amountRands <= microMaxRands(products)) return "MICRO"
  if (amountRands <= qualifyAmountBoundsRands(products).max) return "PERSONAL"
  return "PO_FUNDING"
}

// Build the /site/apply handoff URL for a qualify amount (CENTS) + the wizard's
// term value, classifying the amount via the SHARED tiering rule so the apply
// form applies under the SAME product the wizard priced — and passing an explicit
// `product` so apply doesn't re-derive it. Used for BOTH the affordable amount and
// the suggested-lower amount, so they can never diverge: each classifies the exact
// amount it carries (the suggested amount can be a different tier than the
// requested one, since the affordability search crosses the micro/personal
// boundary). Term is emitted in DAYS (micro: the wizard value is already days;
// personal: months × 30), matching the classified product.
export function qualifyApplyHref(amountCents: number, termDays: number, products: PublicLoanProduct[]): string {
  // The wizard term is CANONICAL DAYS, so it is unit-unambiguous and passes straight
  // through regardless of the amount's tier (a suggested-lower amount that crosses
  // the micro/personal boundary carries the same days). Classify the amount to emit
  // an explicit product so the apply form routes to the SAME product the wizard priced.
  const product = productForAmount(Math.round(amountCents / 100), products) === "MICRO" ? "short-term" : "personal"
  return `/site/apply?amount=${amountCents}&unit=cents&term=${Math.round(termDays)}&product=${product}&prequal=true`
}

// Per-apply-product [min,max] in RANDS, derived from the live products (fail-open
// to static). The single source for the apply form's slider bounds + validation +
// the clamp guardrail above. cents ÷ 100 at the boundary.
export function applyProductLimitsRands(
  products: PublicLoanProduct[],
): Record<ApplyProductType, [number, number]> {
  const rangeFor = (type: ApplyProductType): [number, number] => {
    const code = APPLY_PRODUCT_PUBLIC_CODE[type]
    const product = products.find((p) => p.code === code) ?? getPublicLoanProduct(code)
    return [Math.round(product.minAmount / 100), Math.round(product.maxAmount / 100)]
  }
  return {
    MICRO: rangeFor("MICRO"),
    PERSONAL: rangeFor("PERSONAL"),
    PO_FUNDING: rangeFor("PO_FUNDING"),
  }
}

export function clampPublicLoanAmount(product: PublicLoanProduct, amount: number) {
  if (!Number.isFinite(amount)) return product.defaultAmount
  return Math.max(product.minAmount, Math.min(product.maxAmount, amount))
}

export function clampPublicLoanTerm(product: PublicLoanProduct, term: number) {
  if (product.fixedTerm) return product.fixedTerm
  if (!Number.isFinite(term)) return product.defaultTerm
  return Math.max(product.minTerm, Math.min(product.maxTerm, term))
}

export function getTermDays(product: PublicLoanProduct, term: number) {
  return product.termUnit === "months" ? term * 30 : term
}

export function calculatePublicLoanQuote(product: PublicLoanProduct, rawAmount: number, rawTerm: number): PublicLoanQuote {
  const amount = clampPublicLoanAmount(product, rawAmount)
  const term = clampPublicLoanTerm(product, rawTerm)
  const termDays = getTermDays(product, term)
  const result = calculateLoan({
    principal: amount,
    termDays,
    interestRatePm: product.interestRatePm,
    interestModel: product.interestModel,
    productType: product.productType ?? null,
    initiationFeeModel: product.initiationFeeModel,
    initiationFeePct: product.initiationFeePct,
    initiationFeeMax: product.initiationFeeMax,
    monthlyServiceFee: product.monthlyServiceFee,
  })

  // calculateLoan now bills the monthly service fee on single-payment loans too
  // (it used to be dropped for FLAT/DAILY_ACCRUAL, so this quote added it back by
  // hand). Read the engine's figures directly — the marketing quote and the
  // booked loan are computed by the SAME engine, so they can't drift.
  const serviceFees = result.serviceFees
  const totalRepayable = result.totalRepayable
  const primaryMetric = product.code === "personal" ? result.monthlyInstalment : totalRepayable
  const secondaryMetric = product.code === "personal"
    ? totalRepayable
    : totalRepayable - result.disbursementAmount
  // "Est. APR" was removed from the personal calculator (audit W-1): the old
  // interest / principal formula understated the true reducing-balance rate
  // roughly 2x. All products now surface the loan term as the tertiary metric.
  const tertiaryMetric = term

  return {
    product,
    amount,
    term,
    termDays,
    totalInterest: result.totalInterest,
    initiationFee: result.initiationFee,
    serviceFees,
    totalRepayable,
    monthlyInstalment: result.monthlyInstalment,
    disbursementAmount: result.disbursementAmount,
    primaryMetric,
    secondaryMetric,
    tertiaryMetric,
    schedule: result.schedule,
  }
}

export function buildProductApplyHref(product: PublicLoanProduct, quote: PublicLoanQuote, target: "desktop" | "mobile") {
  const base = target === "mobile" ? product.mobileHref : product.desktopHref
  // Invoice discounting has no LoanProduct to originate — route its CTA to an
  // advisor enquiry instead of the apply form, carrying the amount as context
  // rather than as an applyable product (W-12).
  if (product.code === "invoice-discounting") {
    const enquiry = new URLSearchParams({ enquiry: "invoice-discounting", amount: String(quote.amount) })
    return `/site/contact?${enquiry.toString()}`
  }
  const params = new URLSearchParams({
    product: product.applyProduct,
    amount: String(quote.amount),
    term: String(quote.termDays),
    unit: "cents",
  })
  return `${base}?${params.toString()}`
}

export function formatTerm(product: PublicLoanProduct, term: number) {
  // Singularise at 1 ("1 month" / "1 day") — PO funding's 1-month minimum makes
  // the singular reachable via a plain slider drag.
  const unit = term === 1 ? product.termUnit.slice(0, -1) : product.termUnit
  return `${term} ${unit}`
}

// ── Marketing-copy formatters (Phase 3) ──────────────────────────────────────
// Whole-rand, comma-grouped, no decimals — the style the hardcoded copy used
// ("R500", "R10,000"). CENTS in. Client-safe (no prisma).
export function formatRandsWhole(cents: number): string {
  return `R${Math.round(cents / 100).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`
}

// "R500 – R10,000" from a product's (live) amount range. `sep` matches each
// surface's existing dash (" - ", " – ", "–").
export function formatProductRange(product: PublicLoanProduct, sep = " – "): string {
  return `${formatRandsWhole(product.minAmount)}${sep}${formatRandsWhole(product.maxAmount)}`
}

// "3 – 60 months" / "30 days" (fixed) — a product's term range in its display unit.
export function formatProductTermRange(product: PublicLoanProduct, sep = " – "): string {
  const unit = product.termUnit
  if (product.minTerm === product.maxTerm) return `${product.minTerm} ${unit}`
  return `${product.minTerm}${sep}${product.maxTerm} ${unit}`
}

// A monthly interest rate as a percent string: 0.05 → "5%", 0.025 → "2.5%".
export function formatRatePct(rate: number): string {
  return `${Number((rate * 100).toFixed(2))}%`
}

const INTEREST_MODEL_WORD: Record<PublicLoanProduct["interestModel"], string> = {
  FLAT: "flat",
  REDUCING_BALANCE: "reducing",
  DAILY_ACCRUAL: "daily accrual",
}

// A product's interest line for public pages: "5%/mo flat", "2.8%/mo reducing".
// ONE shared wording so the pricing fee table and the qualify wizard can never
// render the same live rate differently.
export function formatInterestLabel(product: PublicLoanProduct): string {
  return `${formatRatePct(product.interestRatePm)}/mo ${INTEREST_MODEL_WORD[product.interestModel] ?? ""}`.trim()
}

"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { ArrowRight } from "lucide-react"
import { formatZAR } from "@/lib/loan-calculator"
import {
  applyLivePricing,
  buildProductApplyHref,
  calculatePublicLoanQuote,
  formatTerm,
  getPublicLoanProduct,
  publicLoanProducts,
  type PublicLoanProduct,
  type PublicLoanProductCode,
} from "@/lib/public-loan-products"
import { useLivePricing } from "@/lib/use-live-pricing"

type ProductLoanCalculatorProps = {
  variant?: "compact" | "full"
  defaultProduct?: PublicLoanProductCode
}

const LAST_ENQUIRY_KEY = "lms:last-enquiry-reference:v1"

function cleanReference(value: string | null | undefined) {
  if (!value) return ""
  return value.trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80)
}

function readPersistedEnquiryReference() {
  if (typeof window === "undefined") return ""

  const params = new URLSearchParams(window.location.search)
  const fromUrl = cleanReference(
    params.get("enquiryReference") || params.get("sourceReference") || params.get("reference") || params.get("enquiry"),
  )
  if (fromUrl) return fromUrl

  try {
    const raw = window.localStorage.getItem(LAST_ENQUIRY_KEY)
    if (!raw) return ""
    const parsed = JSON.parse(raw) as { reference?: string }
    return cleanReference(parsed.reference)
  } catch {
    return ""
  }
}

function appendEnquiryReference(href: string, enquiryReference: string) {
  if (!enquiryReference) return href
  const [path, query = ""] = href.split("?")
  const params = new URLSearchParams(query)
  params.set("enquiryReference", enquiryReference)
  params.set("sourceReference", enquiryReference)
  return `${path}?${params.toString()}`
}

function formatMetric(label: string, value: number, productCode: PublicLoanProductCode) {
  if (label === "Term") return formatTerm(getPublicLoanProduct(productCode), value)
  return formatZAR(value)
}

export function ProductLoanCalculator({ variant = "full", defaultProduct = "short-term" }: ProductLoanCalculatorProps) {
  // Overlay the LIVE fee structure the admin configured at /settings/products/loan
  // via the shared useLivePricing() hook (the same path the apply form + qualify
  // wizard use). Once it has loaded, only the products this tenant actually has
  // a live row for are offered; the static catalogue is just the copy and
  // defaults for those.
  const { pricing: livePricing, loading } = useLivePricing()
  const products = useMemo<PublicLoanProduct[]>(
    () => applyLivePricing(livePricing).filter((p) => livePricing[p.code]),
    [livePricing],
  )

  if (loading) return <p className="text-sm text-white/58">Loading products…</p>
  if (products.length === 0) return <p className="text-sm text-white/58">No loan products are available yet.</p>
  return <LoanCalculator variant={variant} defaultProduct={defaultProduct} products={products} />
}

function LoanCalculator({ variant, defaultProduct, products }: Required<ProductLoanCalculatorProps> & { products: PublicLoanProduct[] }) {
  const [productCode, setProductCode] = useState<PublicLoanProductCode>(defaultProduct)
  const [amountByProduct, setAmountByProduct] = useState<Record<PublicLoanProductCode, number>>(() => Object.fromEntries(
    publicLoanProducts.map((product) => [product.code, product.defaultAmount]),
  ) as Record<PublicLoanProductCode, number>)
  const [termByProduct, setTermByProduct] = useState<Record<PublicLoanProductCode, number>>(() => Object.fromEntries(
    publicLoanProducts.map((product) => [product.code, product.defaultTerm]),
  ) as Record<PublicLoanProductCode, number>)
  const [enquiryReference, setEnquiryReference] = useState("")
  // Read the URL/localStorage enquiry reference AFTER mount to avoid a
  // server/client hydration mismatch (W-27).
  useEffect(() => {
    // Client-only read of the URL/localStorage enquiry reference after mount,
    // the standard way to avoid a hydration mismatch (W-27).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEnquiryReference(readPersistedEnquiryReference())
  }, [])

  const product = products.find((p) => p.code === productCode) ?? products[0]
  const amount = amountByProduct[product.code]
  const term = termByProduct[product.code]
  const quote = useMemo(() => calculatePublicLoanQuote(product, amount, term), [product, amount, term])
  const desktopHref = appendEnquiryReference(buildProductApplyHref(product, quote, "desktop"), enquiryReference)

  const setAmount = (next: number) => setAmountByProduct((current) => ({ ...current, [product.code]: next }))
  const setTerm = (next: number) => setTermByProduct((current) => ({ ...current, [product.code]: next }))

  const isCompact = variant === "compact"

  return (
    <div className="space-y-5">
      {/* Mobile: a horizontal scroll-snap chip row (no description, single line)
          so the product picker doesn't push the inputs ~2 viewports down (audit
          M9). sm+ restores the original card grid with descriptions. */}
      <div className={isCompact
        ? "grid grid-cols-2 gap-1 border border-white/12 bg-white/[0.04] p-1 text-xs font-semibold sm:grid-cols-3"
        : "flex snap-x snap-mandatory gap-3 overflow-x-auto pb-1 sm:grid sm:snap-none sm:overflow-visible sm:gap-3 sm:pb-0 sm:grid-cols-2 lg:grid-cols-4"}
      >
        {products.map((option) => {
          const selected = product.code === option.code
          return (
            <button
              key={option.code}
              type="button"
              onClick={() => setProductCode(option.code)}
              className={isCompact
                ? selected
                  ? "bg-[#a5b4fc] px-3 py-2 text-[#11141b]"
                  : "px-3 py-2 text-white/58 transition hover:bg-white/[0.06] hover:text-white"
                : `shrink-0 snap-start whitespace-nowrap p-3 text-left sm:shrink sm:whitespace-normal sm:p-4 ${
                    selected
                      ? "border border-[#a5b4fc] bg-[#a5b4fc]/14 shadow-[0_18px_60px_rgba(0,0,0,0.22)]"
                      : "border border-white/12 bg-white/[0.04] transition hover:border-white/28 hover:bg-white/[0.07]"
                  }`}
            >
              <span className={isCompact ? "block" : "block text-sm font-bold text-white"}>{isCompact ? option.shortLabel : option.label}</span>
              {!isCompact && <span className="mt-2 hidden text-xs leading-5 text-white/58 sm:block">{option.description}</span>}
            </button>
          )
        })}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_0.86fr]">
        <div className="space-y-5 self-start border border-white/12 bg-[#11141b]/70 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.28)] backdrop-blur-xl">
          <div>
            <div className="mb-3 flex items-end justify-between gap-3">
              <div>
                <label htmlFor={`${variant}-product-amount`} className="text-xs font-semibold uppercase tracking-[0.18em] text-white/46">
                  {product.amountLabel}
                </label>
                <div className="mt-1 flex items-center border border-white/12 bg-black/20 focus-within:border-[#a5b4fc]">
                  <span className="pl-3 text-sm font-semibold text-white/42">R</span>
                  <input
                    id={`${variant}-product-amount`}
                    type="number"
                    min={product.minAmount / 100}
                    max={product.maxAmount / 100}
                    step={product.amountStep / 100}
                    value={quote.amount / 100}
                    onChange={(event) => setAmount(Math.round(Number(event.target.value) * 100))}
                    onFocus={(event) => event.currentTarget.select()}
                    className="w-36 bg-transparent px-2 py-2 text-xl font-semibold text-white focus:outline-none sm:w-44 sm:text-2xl"
                    inputMode="numeric"
                  />
                </div>
              </div>
              <p className="text-right text-xs leading-5 text-white/44">
                {formatZAR(product.minAmount)} - {formatZAR(product.maxAmount)}
              </p>
            </div>

            {product.amountOptions ? (
              // Compact (home card): a horizontal scroll-snap strip so the five
              // presets never overflow the narrow column — the fixed 5-col grid
              // pushed "R 1,500"/"R 2,000" past their tracks. Full (calculators
              // page) keeps the single-row grid (2 cols on mobile, 5 on sm+; an
              // odd-length list spans its last button across both mobile cols).
              <div className={isCompact
                ? "flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1"
                : "grid grid-cols-2 gap-2 sm:grid-cols-5"}
              >
                {product.amountOptions.map((option, index, options) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setAmount(option)}
                    className={`${isCompact
                      ? "shrink-0 snap-start whitespace-nowrap tabular-nums "
                      : index === options.length - 1 && options.length % 2 === 1 ? "col-span-2 sm:col-span-1 " : ""}${
                      option === quote.amount
                        ? "border border-[#a5b4fc] bg-[#a5b4fc] px-3 py-2 text-xs font-bold text-[#11141b]"
                        : "border border-white/12 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-white/64 hover:border-white/25 hover:text-white"
                    }`}
                  >
                    {formatZAR(option).replace(".00", "")}
                  </button>
                ))}
              </div>
            ) : (
              <input
                type="range"
                min={product.minAmount}
                max={product.maxAmount}
                step={product.amountStep}
                value={quote.amount}
                onChange={(event) => setAmount(Number(event.target.value))}
                className="w-full accent-amber-600"
                aria-label={product.amountLabel}
              />
            )}
          </div>

          <div>
            {product.fixedTerm ? (
              <div>
                <span className="text-xs font-semibold uppercase tracking-[0.18em] text-white/46">Term</span>
                <p className="mt-1 text-xl font-semibold text-white sm:text-2xl">{formatTerm(product, quote.term)}</p>
              </div>
            ) : (
              <>
                <div className="mb-3 flex items-end justify-between gap-3">
                  <div>
                    <label htmlFor={`${variant}-product-term`} className="text-xs font-semibold uppercase tracking-[0.18em] text-white/46">Term</label>
                    <input
                      id={`${variant}-product-term`}
                      type="number"
                      min={product.minTerm}
                      max={product.maxTerm}
                      step={1}
                      value={quote.term}
                      onChange={(event) => setTerm(Number(event.target.value))}
                      onFocus={(event) => event.currentTarget.select()}
                      className="mt-1 w-32 border border-white/12 bg-black/20 px-3 py-2 text-xl font-semibold text-white focus:border-[#a5b4fc] focus:outline-none sm:text-2xl"
                      inputMode="numeric"
                    />
                  </div>
                  <p className="text-right text-xs leading-5 text-white/44">
                    {product.minTerm}-{product.maxTerm} {product.termUnit}
                  </p>
                </div>
                <input
                  type="range"
                  min={product.minTerm}
                  max={product.maxTerm}
                  step={1}
                  value={quote.term}
                  onChange={(event) => setTerm(Number(event.target.value))}
                  className="w-full accent-amber-600"
                  aria-label={`Loan term in ${product.termUnit}`}
                />
                <p className="mt-1 text-sm font-semibold text-[#a5b4fc]">
                  {formatTerm(product, quote.term)}
                  {/* Day-unit slider products (invoice discounting) read awkwardly
                      at the longer end — surface a client-friendly month hint from
                      2 months up. Sub-2-month terms stay in plain days. */}
                  {product.termUnit === "days" && quote.term >= 60 && (
                    <span className="ml-2 font-medium text-white/40">≈ {Math.round(quote.term / 30)} months</span>
                  )}
                </p>
              </>
            )}
          </div>

          {!isCompact && (
            <details className="border border-white/10 bg-white/[0.035] p-4 text-sm text-white/62">
              <summary className="cursor-pointer text-xs font-bold uppercase tracking-[0.18em] text-white/58">Advanced assumptions</summary>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <span>{product.modelLabel}</span>
                <span>{(product.interestRatePm * 100).toFixed(2)}% p/m estimate</span>
                <span>Initiation estimate: {product.initiationFeeModel === "NCA_REG42" ? "per NCA Reg 42" : `${(product.initiationFeePct * 100).toFixed(0)}%`}</span>
                <span>Service fee: {formatZAR(product.monthlyServiceFee)}</span>
              </div>
            </details>
          )}
        </div>

        <div className="border border-white/12 bg-white/[0.045] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.24)] backdrop-blur-xl">
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#a5b4fc]">{product.label}</p>
          <p className="mt-2 text-sm leading-6 text-white/62">{product.description}</p>

          <div className="mt-5 grid gap-3">
            {[
              [product.primaryMetricLabel, formatMetric(product.primaryMetricLabel, quote.primaryMetric, product.code)],
              [product.secondaryMetricLabel, formatMetric(product.secondaryMetricLabel, quote.secondaryMetric, product.code)],
              [product.tertiaryMetricLabel, formatMetric(product.tertiaryMetricLabel, quote.tertiaryMetric, product.code)],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between border border-white/10 bg-black/16 px-3 py-3">
                <span className="text-xs uppercase tracking-[0.14em] text-white/42">{label}</span>
                <span className="text-right text-lg font-semibold text-white">{value}</span>
              </div>
            ))}
          </div>

          {/* The compact widget hides the full breakdown below, so the personal
              "Monthly estimate" tile would otherwise understate month 1: the
              once-off initiation fee is folded into the first instalment only.
              Disclose the higher first payment here too (W-14). */}
          {isCompact && product.code === "personal" && (
            <p className="mt-3 text-xs leading-5 text-white/50">
              Your first payment is{" "}
              <span className="font-semibold text-white/72">{formatZAR(quote.schedule[0]?.totalDue ?? 0)}</span>{" "}
              — it includes the once-off initiation fee; later months are about{" "}
              {formatZAR(quote.primaryMetric)}.
            </p>
          )}

          {!isCompact && (
            <div className="mt-4 grid gap-2 text-sm text-white/62">
              <Row label="Principal" value={formatZAR(quote.amount)} />
              <Row label="Interest estimate" value={formatZAR(quote.totalInterest)} />
              <Row label="Initiation estimate" value={formatZAR(quote.initiationFee)} />
              <Row label="Service fees" value={formatZAR(quote.serviceFees)} />
              {product.code === "personal" && (
                <Row
                  label="First payment (incl. initiation)"
                  value={formatZAR(quote.schedule[0]?.totalDue ?? 0)}
                />
              )}
              <Row label="Total repayable" value={formatZAR(quote.totalRepayable)} strong />
            </div>
          )}

          <p className="mt-4 text-xs leading-5 text-white/46">{product.note}</p>
          <Link href={desktopHref} className="mt-5 flex items-center justify-center gap-2 bg-[#a5b4fc] px-5 py-3 text-sm font-semibold text-[#11141b] transition hover:bg-[#c7d2fe]">
            {product.desktopCta}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={strong ? "flex justify-between border border-[#a5b4fc]/25 bg-[#a5b4fc]/10 px-3 py-2 font-bold text-[#a5b4fc]" : "flex justify-between border border-white/8 bg-black/18 px-3 py-2"}>
      <span className={strong ? "text-white/70" : ""}>{label}</span>
      <span>{value}</span>
    </div>
  )
}

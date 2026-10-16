"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { BackLink } from "@/components/nav/BackLink"
import { formatZAR } from "@/lib/utils"
import type { QualificationResult } from "@/lib/qualify"
import type { ProductType } from "@prisma/client"
import {
  CREDIT_LIFE_DISCLOSURE_VERSION,
  creditLifePrincipalIsEligible,
  type CreditLifeElection,
  type CreditLifePresentedOffer,
} from "@/lib/insurance/credit-life-election"
import {
  ClientSummary,
  ProfileGapWarning,
  PURPOSE_CATEGORIES,
  type ClientInfo,
} from "./parts"
import { creditLifePremiumForAmount, validAmountCents } from "./amount"
import { useT } from "@/lib/i18n/client"

interface ProductInfo {
  id: string
  name: string
  /** Tenant-scoped unique code — the exact product this page sells. */
  code: string
  productType: ProductType
  minAmount: number   // cents
  maxAmount: number   // cents
  minTermDays: number
  maxTermDays: number
}

interface Props {
  productKey: string
  /** The lender's `identity.tradingName`. */
  lenderName: string
  /** The lender's `identity.ncrNumber`. */
  ncrNumber: string
  /** On a demo stack, printed beside the NCR number (lib/config/demo-mode.ts demoLenderNote). */
  demoLenderNote?: string | null
  product: ProductInfo
  client: ClientInfo
  qualification: QualificationResult | null
  creditLifeOffer: CreditLifePresentedOffer | null
}

export function PortalApplyProductClient({ productKey, lenderName, ncrNumber, demoLenderNote, product, client, creditLifeOffer }: Props) {
  const router = useRouter()
  const t = useT("portalApply")

  const fixedTerm = product.minTermDays === product.maxTermDays

  const [amount, setAmount] = useState<string>("")
  const [termDays, setTermDays] = useState<string>(fixedTerm ? String(product.minTermDays) : "")
  const [purpose, setPurpose] = useState("")
  const [category, setCategory] = useState<string>("")
  const [affordabilityDeclared, setAffordabilityDeclared] = useState(false)
  const [pasqDeliveryUnderstood, setPasqDeliveryUnderstood] = useState(false)
  const [creditLifeElection, setCreditLifeElection] = useState<CreditLifeElection | "">("")
  const [creditLifeDisclosureAcknowledged, setCreditLifeDisclosureAcknowledged] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const profileIncomplete =
    !client.idNumber || !client.phone || client.monthlyIncome <= 0

  const amountCents = validAmountCents(product, amount)
  const amountOutOfRange = amountCents === null
  const creditLifeMonthlyPremiumCents = creditLifePremiumForAmount(amountCents)
  const creditLifeAvailable =
    creditLifeOffer?.autoBundleEnabled === true
    && amountCents !== null
    && creditLifePrincipalIsEligible(amountCents)

  const termNum = Number(termDays)
  const termOutOfRange = !fixedTerm && (
    termDays.trim() === ""
    || !Number.isInteger(termNum)
    || termNum < product.minTermDays
    || termNum > product.maxTermDays
  )

  const canSubmit =
    !profileIncomplete
    && !amountOutOfRange
    && !termOutOfRange
    && purpose.trim().length >= 3
    && affordabilityDeclared
    // With no configured credit-life product there is no cover to offer, so
    // there is no election to make and nothing to acknowledge.
    && (
      creditLifeOffer === null
      || (
        (creditLifeElection === "ACCEPTED" || creditLifeElection === "DECLINED")
        && (creditLifeElection === "DECLINED" || creditLifeAvailable)
        && creditLifeDisclosureAcknowledged
      )
    )
    && pasqDeliveryUnderstood
    && !submitting

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!canSubmit || amountCents === null) return
    setSubmitting(true)

    try {
      const res = await fetch("/api/portal/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productCode: product.code,
          amount: amountCents / 100,
          termDays: fixedTerm ? undefined : termNum,
          purpose: purpose.trim(),
          loanPurposeCategory: category || null,
          affordabilityDeclared,
          pasqDeliveryUnderstood,
          // No offer rendered ⇒ no election exists; never post the "" the
          // state initialises to — the server treats a blank as absent, but
          // the payload should be truthful in the first place.
          creditLifeElection: creditLifeOffer === null && creditLifeElection === ""
            ? undefined
            : creditLifeElection,
          creditLifeDisclosureAcknowledged,
          creditLifeProductId: creditLifeOffer?.productId,
          creditLifeProductName: creditLifeOffer?.productName,
          creditLifeInsurerId: creditLifeOffer?.insurerId,
          creditLifeInsurerName: creditLifeOffer?.insurerName,
          creditLifeMonthlyPremiumCents,
          creditLifeDisclosureVersion: CREDIT_LIFE_DISCLOSURE_VERSION,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : t("errGeneric"))
        return
      }
      router.push(`/portal/applications/${data.id}`)
      router.refresh()
    } catch {
      setError(t("errNetwork"))
    } finally {
      setSubmitting(false)
    }
  }

  const inputClass =
    "w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#4F46E5]"
  const labelClass = "block text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1"

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <BackLink href="/portal/apply" label={t("backToApply")} className="mb-6" />

      <div className="mb-6">
        <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#4F46E5] mb-1">
          {product.name}
        </p>
        <h1 className="text-2xl font-bold text-gray-900">
          {t("applyForProduct", { product: product.name })}
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          {t("profileOnFile")}
        </p>
      </div>

      <ProfileGapWarning client={client} />
      <ClientSummary client={client} />

      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 space-y-5"
      >
        <div>
          <label htmlFor="amount" className={labelClass}>
            {t("amountBetween", { min: formatZAR(product.minAmount), max: formatZAR(product.maxAmount) })}
          </label>
          <input
            id="amount"
            type="number"
            min={product.minAmount / 100}
            max={product.maxAmount / 100}
            step={50}
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value)
              setCreditLifeDisclosureAcknowledged(false)
            }}
            className={inputClass}
            required
          />
        </div>

        {!fixedTerm && (
          <div>
            <label htmlFor="termDays" className={labelClass}>
              {t("termBetween", { min: product.minTermDays, max: product.maxTermDays })}
            </label>
            <input
              id="termDays"
              type="number"
              min={product.minTermDays}
              max={product.maxTermDays}
              step={1}
              value={termDays}
              onChange={(e) => {
                setTermDays(e.target.value)
                setCreditLifeDisclosureAcknowledged(false)
              }}
              className={inputClass}
              required
            />
          </div>
        )}

        <div>
          <label htmlFor="category" className={labelClass}>{t("categoryLabel")}</label>
          <select
            id="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className={inputClass}
          >
            <option value="">{t("categoryPlaceholder")}</option>
            {PURPOSE_CATEGORIES.map(({ value, label }) => (
              <option key={value} value={value}>{t(label)}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="purpose" className={labelClass}>
            {t("purposeLabel")} <span className="text-gray-400 normal-case">{t("purposeHint")}</span>
          </label>
          <textarea
            id="purpose"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            rows={3}
            maxLength={500}
            className={inputClass}
            required
          />
        </div>

        <div className="space-y-3 pt-2 border-t border-gray-100">
          {creditLifeOffer && amountCents !== null && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
            <div>
              <p className="text-sm font-semibold text-gray-900">Credit life election</p>
              {creditLifeAvailable ? (
                <p className="mt-1 text-xs text-gray-600">
                  {creditLifeOffer.productName} · {creditLifeOffer.insurerName} · exact monthly
                  premium <span className="font-semibold">{formatZAR(creditLifeMonthlyPremiumCents)}</span>
                </p>
              ) : (
                <p className="mt-1 text-xs text-gray-600">
                  Credit-life cover is not available for this application. You may
                  proceed without cover.
                </p>
              )}
            </div>
            <label className="flex items-start gap-3 text-sm text-gray-700 cursor-pointer">
              <input
                type="radio"
                name="creditLifeElection"
                checked={creditLifeElection === "ACCEPTED"}
                disabled={!creditLifeAvailable}
                onChange={() => {
                  setCreditLifeElection("ACCEPTED")
                  setCreditLifeDisclosureAcknowledged(false)
                }}
                className="mt-1 h-4 w-4 accent-[#4F46E5]"
              />
              <span>Add the offered credit-life cover.</span>
            </label>
            <label className="flex items-start gap-3 text-sm text-gray-700 cursor-pointer">
              <input
                type="radio"
                name="creditLifeElection"
                checked={creditLifeElection === "DECLINED"}
                onChange={() => {
                  setCreditLifeElection("DECLINED")
                  setCreditLifeDisclosureAcknowledged(false)
                }}
                className="mt-1 h-4 w-4 accent-[#4F46E5]"
              />
              <span>
                {creditLifeAvailable
                  ? "Decline the offered bundled cover."
                  : "Proceed without credit-life cover."}
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={creditLifeDisclosureAcknowledged}
                disabled={
                  !creditLifeElection
                  || (!creditLifeAvailable && creditLifeElection !== "DECLINED")
                }
                onChange={(e) => {
                  setCreditLifeDisclosureAcknowledged(e.target.checked)
                }}
                className="mt-1 h-4 w-4 accent-[#4F46E5]"
              />
              <span>
                {creditLifeAvailable
                  ? "I confirm I was shown the product, insurer, exact monthly premium and selected option before PASQ generation."
                  : "I understand that this application will proceed without credit-life cover before PASQ generation."}
              </span>
            </label>
          </div>
          )}

          <label className="flex items-start gap-3 text-sm text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={affordabilityDeclared}
              onChange={(e) => setAffordabilityDeclared(e.target.checked)}
              className="mt-1 h-4 w-4 accent-[#4F46E5]"
            />
            <span>
              I confirm the income, expenses and debt obligations on my profile are
              accurate. I understand {lenderName} will use this information to assess
              affordability under the National Credit Act.
            </span>
          </label>

          <label className="flex items-start gap-3 text-sm text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={pasqDeliveryUnderstood}
              // Gate this on the credit-life acknowledgement ONLY when cover was
              // actually offered. With no configured offer the credit-life block
              // never renders, so creditLifeDisclosureAcknowledged can never
              // become true — which left this permanently disabled and made the
              // whole portal application unsubmittable. canSubmit already
              // exempts the no-offer case; this prop did not.
              disabled={creditLifeOffer !== null && !creditLifeDisclosureAcknowledged}
              onChange={(e) => setPasqDeliveryUnderstood(e.target.checked)}
              className="mt-1 h-4 w-4 accent-[#4F46E5]"
            />
            <span>
              I understand I will receive a Pre-Agreement Statement &amp; Quotation
              (PASQ) for review in this portal. I must open and acknowledge that
              exact document before approval; this checkbox is not the PASQ
              acknowledgement. This submission does not create a binding loan.
            </span>
          </label>
        </div>

        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-2">
          <Link
            href="/portal/apply"
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            {t("cancel")}
          </Link>
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ backgroundColor: "#4F46E5" }}
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("submit")}
          </button>
        </div>

        <p className="text-[11px] text-gray-400 pt-2">
          Registered credit provider (NCR Reg: {ncrNumber}).{demoLenderNote && <> {demoLenderNote}</>} Product reference: {productKey.toUpperCase()}.
        </p>
      </form>
    </div>
  )
}

"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

import type { Advisor, Client, PolicyDraftData, Product, Step } from "./wizard/types"
import { formatCents } from "@/lib/insurance/rand-cents"
import { Step1PolicyDetails } from "./wizard/Step1PolicyDetails"
import { Step2Disclosure } from "./wizard/Step2Disclosure"
import { Step3Confirm } from "./wizard/Step3Confirm"

interface Props {
  clients: Client[]
  advisors: Advisor[]
  products: Product[]
}

export function PolicyCreationWizard({ clients, advisors, products }: Props) {
  const router = useRouter()

  const [step, setStep] = useState<Step>(1)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [draftToken, setDraftToken] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  // The premium the product's ACTIVE rate table produced, as named by the draft
  // route's PREMIUM_MISMATCH refusal. Offered as a one-click fix on step 1.
  const [ratedPremium, setRatedPremium] = useState<string | null>(null)

  const [selectedProductId, setSelectedProductId] = useState<string>("")
  const [useProduct, setUseProduct] = useState<"catalogue" | "manual">(
    products.some((p) => p.active) ? "catalogue" : "manual"
  )

  const [clientSearch, setClientSearch] = useState("")

  const [data, setData] = useState<PolicyDraftData>({
    clientId: "",
    advisorId: "",
    productId: "",
    type: "FUNERAL_COVER",
    sumAssured: "",
    premiumAmount: "",
    commissionRate: "15",
    startDate: new Date().toISOString().slice(0, 10),
    // Never a default: an insurer named here implies an arrangement the lender
    // may not have. A catalogue product brings its own (applyProduct).
    insurer: "",
    linkedLoanRef: "",
    vehicleRegNumber: "",
    vehicleValue: "",
    vehicleUse: "PRIVATE",
    propertyAddress: "",
    constructionType: "BRICK",
    propertyValue: "",
  })

  function set(k: keyof PolicyDraftData, v: string) {
    // The rated premium belongs to one client, cover and product: stale once any changes.
    if (k === "clientId" || k === "sumAssured" || k === "type") setRatedPremium(null)
    setData((prev) => ({ ...prev, [k]: v }))
  }

  function applyRatedPremium() {
    if (!ratedPremium) return
    set("premiumAmount", ratedPremium)
    setRatedPremium(null)
    setError(null)
  }

  function applyProduct(product: Product) {
    setRatedPremium(null)
    setSelectedProductId(product.id)
    setData((prev) => ({
      ...prev,
      type: product.type,
      insurer: product.insurerName ?? "",
      // Same numbers the picker card shows: the cheapest quotable band for a
      // rated product, nothing (priced on quote) when none is, else the flat terms.
      sumAssured: product.headline.kind === "from" ? formatCents(product.headline.coverCents)
        : product.headline.kind === "quote" ? "" : product.sumAssured.toString(),
      premiumAmount: product.headline.kind === "from" ? formatCents(product.headline.premiumCents)
        : product.headline.kind === "quote" ? "" : product.premiumAmount.toString(),
      commissionRate: (product.commissionRate * 100).toFixed(2),
      productId: product.id,
    }))
  }

  // ── Step 1 → 2: render the FAIS disclosure draft on the server ─────────────
  async function renderDisclosure() {
    setValidationError(null)
    setError(null)
    setRatedPremium(null)

    if (!data.clientId) {
      setValidationError("Please select a client.")
      return
    }
    if (!data.advisorId) {
      setValidationError("Please select an advisor.")
      return
    }
    if (!data.sumAssured || isNaN(parseFloat(data.sumAssured))) {
      setValidationError("Please enter a valid sum assured.")
      return
    }
    if (!data.premiumAmount || isNaN(parseFloat(data.premiumAmount))) {
      setValidationError("Please enter a valid monthly premium.")
      return
    }

    const sumAssuredVal = parseFloat(data.sumAssured)
    if (data.type === "LIFE_INSURANCE") {
      if (sumAssuredVal < 100000 || sumAssuredVal > 5000000) {
        setValidationError(
          "Life Insurance sum assured must be between R100,000 and R5,000,000."
        )
        return
      }
    }

    setSubmitting(true)
    try {
      const res = await fetch("/api/insurance/policies/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: data.clientId,
          advisorId: data.advisorId,
          productId: data.productId || null,
          type: data.type,
          sumAssured: parseFloat(data.sumAssured),     // rands — draft endpoint expects rands
          premiumAmount: parseFloat(data.premiumAmount), // rands
        }),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string; reason?: string; derivedPremium?: unknown }
        setError(json.error ?? "Failed to render disclosure")
        if (json.reason === "PREMIUM_MISMATCH" && typeof json.derivedPremium === "string" && /^\d+\.\d{2}$/.test(json.derivedPremium)) {
          setRatedPremium(json.derivedPremium)
        }
        return
      }
      const json = await res.json()
      setPdfUrl(json.pdfUrl)
      setDraftToken(json.draftToken)
      setStep(2)
    } catch {
      setError("Network error — please try again")
    } finally {
      setSubmitting(false)
    }
  }

  // ── Step 3 → submit: create the policy through the FAIS gate ───────────────
  async function submitPolicy() {
    if (!draftToken || !pdfUrl || !acknowledged) return
    setError(null)
    setSubmitting(true)

    const clientEmail = clients.find((c) => c.id === data.clientId)?.email

    try {
      const res = await fetch("/api/insurance/policies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientEmail,                                        // backward-compat field
          clientId: data.clientId,                           // verified in token
          advisorId: data.advisorId,
          productId: data.productId || null,
          type: data.type,
          sumAssured: Math.round(parseFloat(data.sumAssured) * 100),       // cents
          premiumAmount: Math.round(parseFloat(data.premiumAmount) * 100), // cents
          commissionRate: parseFloat(data.commissionRate) / 100,
          startDate: data.startDate,
          insurer: data.insurer || null,
          linkedLoanRef: data.linkedLoanRef || null,
          // Risk fields
          vehicleRegNumber: data.vehicleRegNumber || null,
          vehicleValue: data.vehicleValue ? parseFloat(data.vehicleValue) : null,
          vehicleUse: data.vehicleUse || null,
          propertyAddress: data.propertyAddress || null,
          constructionType: data.constructionType || null,
          propertyValue: data.propertyValue ? parseFloat(data.propertyValue) : null,
          // FAIS gate fields — server discards faisDisclosureAt and stamps from
          // its own clock, but a value is still required for presence.
          faisDisclosureAt: new Date().toISOString(),
          faisDisclosurePdfUrl: pdfUrl,
          draftToken,
        }),
      })

      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        setError((json as { error?: string }).error ?? "Failed to create policy")
        return
      }
      await res.json()
      // Land on the policy list (ordered createdAt desc → the new policy is at
      // the top). The previous target `/insurance/policies` is not a real route,
      // so staff were dumped on the marketing 404 after every successful create.
      router.push("/insurance")
    } catch {
      setError("Network error — please try again")
    } finally {
      setSubmitting(false)
    }
  }

  if (step === 1) {
    return (
      <Step1PolicyDetails
        data={data}
        set={set}
        clients={clients}
        advisors={advisors}
        products={products}
        selectedProductId={selectedProductId}
        applyProduct={applyProduct}
        useProduct={useProduct}
        setUseProduct={setUseProduct}
        clientSearch={clientSearch}
        setClientSearch={setClientSearch}
        validationError={validationError}
        setValidationError={setValidationError}
        error={error}
        submitting={submitting}
        ratedPremium={ratedPremium}
        applyRatedPremium={applyRatedPremium}
        onNext={renderDisclosure}
      />
    )
  }

  if (step === 2) {
    return (
      <Step2Disclosure
        pdfUrl={pdfUrl!}
        acknowledged={acknowledged}
        setAcknowledged={setAcknowledged}
        error={error}
        onBack={() => {
          setPdfUrl(null)
          setDraftToken(null)
          setAcknowledged(false)
          setError(null)
          setStep(1)
        }}
        onNext={() => {
          if (acknowledged) setStep(3)
        }}
      />
    )
  }

  return (
    <Step3Confirm
      data={data}
      clients={clients}
      advisors={advisors}
      error={error}
      submitting={submitting}
      onBack={() => {
        setError(null)
        setStep(2)
      }}
      onSubmit={submitPolicy}
    />
  )
}

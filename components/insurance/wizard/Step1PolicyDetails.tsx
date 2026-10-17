import { ClientPicker } from "@/components/wizard/ClientPicker"
import { StepBar } from "@/components/wizard/StepBar"
import { MotorRiskFields, PropertyRiskFields } from "./RiskFields"
import { ProductPicker } from "./ProductPicker"
import { INSURANCE_STEP_LABELS, TYPE_LABELS, inp, lbl } from "./constants"
import type { Advisor, Client, PolicyDraftData, Product } from "./types"
import { formatZAR } from "@/lib/utils"
import { premiumCommission } from "@/lib/insurance/commission"

interface Props {
  data: PolicyDraftData
  set: (k: keyof PolicyDraftData, v: string) => void

  clients: Client[]
  advisors: Advisor[]
  products: Product[]

  selectedProductId: string
  applyProduct: (p: Product) => void

  useProduct: "catalogue" | "manual"
  setUseProduct: (v: "catalogue" | "manual") => void

  clientSearch: string
  setClientSearch: (v: string) => void

  validationError: string | null
  setValidationError: (v: string | null) => void
  error: string | null
  submitting: boolean

  /** Rands ("268.00") the product's rate table produced for this client and cover, once the server has refused another premium. */
  ratedPremium: string | null
  applyRatedPremium: () => void

  onNext: () => void
}

export function Step1PolicyDetails(props: Props) {
  const {
    data,
    set,
    clients,
    advisors,
    products,
    selectedProductId,
    applyProduct,
    useProduct,
    setUseProduct,
    clientSearch,
    setClientSearch,
    validationError,
    setValidationError,
    error,
    submitting,
    ratedPremium,
    applyRatedPremium,
    onNext,
  } = props

  const activeProducts = products.filter((p) => p.active)
  // Block "Next" when the user is in catalogue mode and no product is picked
  // AND sum-assured is still blank (i.e. they haven't typed anything either).
  const blockedByCataloguePick =
    useProduct === "catalogue" &&
    activeProducts.length > 0 &&
    !selectedProductId &&
    !data.sumAssured

  const nextDisabled =
    submitting || !data.clientId || !data.advisorId || blockedByCataloguePick

  return (
    <div className="space-y-5">
      <StepBar step={1} labels={INSURANCE_STEP_LABELS} />

      <ProductPicker
        products={products}
        selectedProductId={selectedProductId}
        applyProduct={applyProduct}
        useProduct={useProduct}
        setUseProduct={setUseProduct}
      />

      <ClientPicker
        clients={clients}
        selectedClientId={data.clientId}
        clientSearch={clientSearch}
        setClientSearch={setClientSearch}
        onSelect={(id) => set("clientId", id)}
      />

      {/* Policy details */}
      <div className="bg-white rounded-2xl shadow-sm p-5 space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          Policy Details
        </p>

        <div>
          <label className={lbl}>Advisor *</label>
          <select
            className={`${inp} bg-white`}
            value={data.advisorId}
            onChange={(e) => set("advisorId", e.target.value)}
            required
          >
            <option value="">— Select advisor —</option>
            {advisors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name ?? a.email}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={lbl}>Policy Type *</label>
            <select
              className={`${inp} bg-white`}
              value={data.type}
              onChange={(e) => set("type", e.target.value)}
            >
              {Object.entries(TYPE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={lbl}>Insurer</label>
            <input
              className={inp}
              aria-label="Insurer"
              placeholder="As named in the product terms"
              value={data.insurer}
              onChange={(e) => set("insurer", e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={lbl}>Sum Assured (R) *</label>
            <input
              className={`${inp} ${selectedProductId ? "bg-amber-50/50" : ""}`}
              type="text"
              inputMode="decimal"
              required
              placeholder="50000"
              value={data.sumAssured}
              onChange={(e) => {
                set("sumAssured", e.target.value.replace(",", "."))
                setValidationError(null)
              }}
            />
            {data.type === "LIFE_INSURANCE" && (
              <p className="text-[11px] text-gray-400 mt-1">
                Must be between R100,000 and R5,000,000
              </p>
            )}
          </div>
          <div>
            <label className={lbl}>Monthly Premium (R) *</label>
            <input
              className={`${inp} ${selectedProductId ? "bg-amber-50/50" : ""}`}
              type="text"
              inputMode="decimal"
              required
              placeholder="150"
              value={data.premiumAmount}
              onChange={(e) => set("premiumAmount", e.target.value.replace(",", "."))}
            />
            {ratedPremium && parseFloat(data.premiumAmount) !== parseFloat(ratedPremium) && (
              <button
                type="button"
                onClick={applyRatedPremium}
                className="mt-1 text-[11px] font-semibold text-[#4F46E5] underline"
              >
                Use R{ratedPremium} (rate table premium)
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={lbl}>Commission Rate (%)</label>
            <input
              className={`${inp} ${selectedProductId ? "bg-amber-50/50" : ""}`}
              type="text"
              inputMode="decimal"
              value={data.commissionRate}
              onChange={(e) =>
                set("commissionRate", e.target.value.replace(",", "."))
              }
            />
            {data.premiumAmount && data.commissionRate && (
              <p className="text-[11px] text-gray-400 mt-1">
                Commission:{" "}
                {formatZAR(
                  Math.round(
                    premiumCommission(
                      parseFloat(data.premiumAmount || "0"),
                      parseFloat(data.commissionRate || "0") / 100
                    ) * 100
                  )
                )}{" "}
                a month
              </p>
            )}
          </div>
          <div>
            <label className={lbl}>Start Date *</label>
            <input
              className={inp}
              type="date"
              required
              value={data.startDate}
              onChange={(e) => set("startDate", e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className={lbl}>Link to Loan Reference (optional)</label>
          <input
            className={inp}
            placeholder="LN-…"
            value={data.linkedLoanRef}
            onChange={(e) => set("linkedLoanRef", e.target.value)}
          />
          <p className="text-[11px] text-gray-400 mt-1">
            For credit life policies — links policy to an existing loan
          </p>
        </div>
      </div>

      <MotorRiskFields data={data} set={set} />
      <PropertyRiskFields data={data} set={set} />

      {/* Validation + errors */}
      {validationError && (
        <p className="text-sm text-red-600 bg-red-50 px-4 py-3 rounded-xl border border-red-100">
          {validationError}
        </p>
      )}
      {error && (
        <p className="text-sm text-red-600 bg-red-50 px-4 py-3 rounded-xl border border-red-100">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={onNext}
        disabled={nextDisabled}
        className="w-full py-3 bg-[#4F46E5] text-white rounded-xl font-semibold text-sm hover:bg-[#4338CA] disabled:opacity-50 transition-colors"
      >
        {submitting ? "Rendering disclosure…" : "Next: Review FAIS Disclosure →"}
      </button>
    </div>
  )
}

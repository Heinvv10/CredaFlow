import { StepBar } from "@/components/wizard/StepBar"
import { INSURANCE_STEP_LABELS, TYPE_LABELS, formatR } from "./constants"
import type { Advisor, Client, PolicyDraftData } from "./types"
import { formatZAR } from "@/lib/utils"
import { premiumCommission } from "@/lib/insurance/commission"

interface Props {
  data: PolicyDraftData
  clients: Client[]
  advisors: Advisor[]
  error: string | null
  submitting: boolean
  onBack: () => void
  onSubmit: () => void
}

export function Step3Confirm({
  data,
  clients,
  advisors,
  error,
  submitting,
  onBack,
  onSubmit,
}: Props) {
  const selectedClient = clients.find((c) => c.id === data.clientId) ?? null
  const advisor = advisors.find((a) => a.id === data.advisorId)

  const sumAssuredNum = parseFloat(data.sumAssured || "0")
  const premiumNum = parseFloat(data.premiumAmount || "0")
  const commissionNum = parseFloat(data.commissionRate || "0")

  const rows: Array<[string, string]> = [
    [
      "Client",
      selectedClient
        ? `${selectedClient.firstName} ${selectedClient.lastName} (${selectedClient.email})`
        : "—",
    ],
    ["Advisor", advisor?.name ?? advisor?.email ?? "—"],
    ["Policy Type", TYPE_LABELS[data.type] || data.type],
    ["Insurer", data.insurer || "—"],
    ["Sum Assured", formatR(sumAssuredNum)],
    ["Monthly Premium", formatR(premiumNum)],
    ["Commission Rate", `${commissionNum}%`],
    ["Commission Amount", `${formatZAR(Math.round(premiumCommission(premiumNum, commissionNum / 100) * 100))} a month`],
    ["Start Date", data.startDate],
    ...(data.linkedLoanRef ? ([["Linked Loan", data.linkedLoanRef]] as Array<[string, string]>) : []),
  ]

  return (
    <div className="space-y-5">
      <StepBar step={3} labels={INSURANCE_STEP_LABELS} />

      <div className="bg-white rounded-2xl shadow-sm p-5 space-y-3">
        <h2 className="text-sm font-semibold text-[#1b1d24] mb-3">Policy Summary</h2>

        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between text-sm">
            <span className="text-gray-500">{label}</span>
            <span className="font-medium text-[#1b1d24] text-right max-w-[60%]">{value}</span>
          </div>
        ))}

        <div className="mt-4 pt-4 border-t border-gray-100">
          <p className="text-xs text-gray-500">
            FAIS disclosure acknowledged and recorded. The disclosure PDF will be attached to
            this policy record.
          </p>
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 px-4 py-3 rounded-xl border border-red-100">
          {error}
        </p>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 py-3 border border-gray-200 rounded-xl font-semibold text-sm text-gray-600 hover:bg-gray-50 transition-colors"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting}
          className="flex-1 py-3 bg-[#4F46E5] text-white rounded-xl font-semibold text-sm hover:bg-[#4338CA] disabled:opacity-50 transition-colors"
        >
          {submitting ? "Creating policy…" : "Create Policy"}
        </button>
      </div>
    </div>
  )
}

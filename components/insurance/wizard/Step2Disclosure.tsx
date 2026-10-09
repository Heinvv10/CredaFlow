import { StepBar } from "@/components/wizard/StepBar"
import { INSURANCE_STEP_LABELS } from "./constants"

interface Props {
  pdfUrl: string
  acknowledged: boolean
  setAcknowledged: (v: boolean) => void
  error: string | null
  onBack: () => void
  onNext: () => void
}

export function Step2Disclosure({
  pdfUrl,
  acknowledged,
  setAcknowledged,
  error,
  onBack,
  onNext,
}: Props) {
  return (
    <div className="space-y-5">
      <StepBar step={2} labels={INSURANCE_STEP_LABELS} />

      <div className="bg-white rounded-2xl shadow-sm p-5">
        <h2 className="text-sm font-semibold text-[#1b1d24] mb-1">
          FAIS Disclosure Document
        </h2>
        <p className="text-xs text-gray-500 mb-4">
          Walk the client through the disclosure below before proceeding.
        </p>
        <iframe
          src={pdfUrl}
          className="w-full border border-gray-200 rounded-lg"
          style={{ height: "60vh" }}
          title="FAIS Disclosure"
        />
      </div>

      <div className="bg-white rounded-2xl shadow-sm p-5">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 accent-[#4F46E5]"
          />
          <span className="text-sm text-[#1b1d24]">
            I have walked the client through this disclosure and they have acknowledged it.
          </span>
        </label>
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
          onClick={onNext}
          disabled={!acknowledged}
          className="flex-1 py-3 bg-[#4F46E5] text-white rounded-xl font-semibold text-sm hover:bg-[#4338CA] disabled:opacity-50 transition-colors"
        >
          Next: Confirm & Create Policy →
        </button>
      </div>
    </div>
  )
}

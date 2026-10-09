"use client"

import { Check, X } from "lucide-react"
import { SAST_TIME_ZONE } from "@/lib/utils"

interface ConsentStatusProps {
  consent: {
    creditBureauEnquiry: boolean
    insuranceUnderwriting: boolean
    thirdPartySharing: boolean
    automatedDecisionMaking: boolean
    capturedAt: Date | null
    withdrawnAt: Date | null
  } | null
}

const PROCESSING_LABELS = [
  { key: "creditBureauEnquiry", label: "Credit bureau enquiry" },
  { key: "insuranceUnderwriting", label: "Insurance underwriting" },
  { key: "thirdPartySharing", label: "Third-party sharing" },
  { key: "automatedDecisionMaking", label: "Automated decision-making" },
] as const

export function ConsentStatus({ consent }: ConsentStatusProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 mb-5">
      <h2 className="text-sm font-bold text-gray-900 mb-1">Loan-related Consents</h2>
      <p className="text-xs text-gray-500 mb-4">
        These are required to process your loan applications.
      </p>

      <ul className="space-y-2">
        {PROCESSING_LABELS.map(({ key, label }) => {
          const granted = consent ? (consent[key] as boolean) : false
          return (
            <li key={key} className="flex items-center justify-between text-sm">
              <span className="text-gray-700">{label}</span>
              {granted ? (
                <span className="inline-flex items-center gap-1 text-green-700">
                  <Check className="w-4 h-4" /> Granted
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-gray-400">
                  <X className="w-4 h-4" /> Not granted
                </span>
              )}
            </li>
          )
        })}
      </ul>

      {consent?.withdrawnAt && (
        <p className="text-xs text-amber-700 mt-4">
          Consent withdrawn on{" "}
          {new Date(consent.withdrawnAt).toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE })}.
        </p>
      )}
      {!consent && (
        <p className="text-xs text-gray-500 mt-4">
          Consent not yet captured — visit your nearest branch to complete onboarding.
        </p>
      )}

      <p className="text-xs text-gray-500 mt-4">
        To grant or withdraw consent for these purposes, please contact us
        — they affect your loan eligibility.
      </p>
    </div>
  )
}

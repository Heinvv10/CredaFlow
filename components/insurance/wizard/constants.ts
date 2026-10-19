export const TYPE_LABELS: Record<string, string> = {
  FUNERAL_COVER: "Funeral Cover",
  CREDIT_LIFE: "Credit Life",
  LIFE_INSURANCE: "Life Insurance",
  SHORT_TERM_MOTOR: "Short-term Motor",
  SHORT_TERM_HOME: "Short-term Home",
  SHORT_TERM_CONTENTS: "Short-term Contents",
  BUSINESS_INSURANCE: "Business Insurance",
}

// Shared Tailwind classes for inputs / labels — kept identical to the pre-split
// wizard so the visual output is byte-for-byte unchanged.
export const inp =
  "w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]/30 focus:border-[#4F46E5]"
export const lbl = "block text-xs font-semibold text-gray-600 mb-1.5"

export const INSURANCE_STEP_LABELS = ["Policy Details", "FAIS Disclosure", "Confirm"] as const

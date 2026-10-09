import type { LoanPurposeCategory } from "@prisma/client"

// Single source of truth for the `LoanPurposeCategory` enum's UI presentation.
// Imported by Step 2 of the application wizard and by the CRM lead-conversion
// form. Type-only Prisma import is stripped at build time, so no Prisma
// runtime cost in the client bundle. The `value` type union makes Prisma
// enum renames a compile-time error in this file.
export const LOAN_PURPOSE_OPTIONS: ReadonlyArray<{
  value: LoanPurposeCategory
  label: string
}> = [
  { value: "DEBT_CONSOLIDATION", label: "Debt Consolidation" },
  { value: "MEDICAL", label: "Medical" },
  { value: "EDUCATION", label: "Education" },
  { value: "HOME_IMPROVEMENT", label: "Home Improvement" },
  { value: "VEHICLE", label: "Vehicle" },
  { value: "BUSINESS", label: "Business" },
  { value: "HOUSEHOLD", label: "Household" },
  { value: "FUNERAL", label: "Funeral" },
  { value: "OTHER", label: "Other" },
]

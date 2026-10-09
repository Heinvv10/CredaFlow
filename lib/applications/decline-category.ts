import type { DeclineCategory } from "@prisma/client"

/**
 * Coarse decline categories for internal reporting. This is NOT the
 * consumer's NCA s.62 statement of reasons.
 *
 * Client-safe: no Prisma runtime import, so the decline form can use it.
 */
export const DECLINE_CATEGORY_LABELS: Record<DeclineCategory, string> = {
  AFFORDABILITY: "Affordability",
  BUREAU_SCORE: "Bureau score",
  ADVERSE_LISTING: "Adverse listing / judgment",
  DEBT_REVIEW: "Under debt review",
  DOCUMENTS_INCOMPLETE: "Documents incomplete",
  IDENTITY: "Identity could not be verified",
  WITHDRAWN: "Client withdrew",
}

export const DECLINE_CATEGORIES = Object.keys(DECLINE_CATEGORY_LABELS) as DeclineCategory[]

export function parseDeclineCategory(value: unknown): DeclineCategory | null {
  return typeof value === "string" && (DECLINE_CATEGORIES as string[]).includes(value)
    ? (value as DeclineCategory)
    : null
}

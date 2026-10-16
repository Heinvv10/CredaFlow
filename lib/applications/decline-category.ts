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
  FRAUD: "Suspected fraud",
  POLICY: "Lending policy",
  OTHER: "Other",
}

export const DECLINE_CATEGORIES = Object.keys(DECLINE_CATEGORY_LABELS) as DeclineCategory[]

/**
 * The reason the CLIENT is shown for each category: the starting text of the
 * staff decline form's "reason shown to the client", which staff may edit. It
 * reaches the borrower in the portal, by email and WhatsApp, so it says what
 * the decision rested on in plain words and never carries an internal finding
 * (a suspected fraud is "could not verify"). Other has no default: staff write it.
 */
export const DECLINE_CLIENT_REASONS: Record<DeclineCategory, string> = {
  AFFORDABILITY: "After your expenses and existing debt repayments, your income is not enough to afford the instalment on this loan.",
  BUREAU_SCORE: "Your credit record at the credit bureau does not meet our lending criteria.",
  ADVERSE_LISTING: "Your credit record at the credit bureau shows an adverse listing or a judgment.",
  DEBT_REVIEW: "Your credit record at the credit bureau shows that you are under debt review.",
  DOCUMENTS_INCOMPLETE: "We did not receive all the documents we need to assess your application.",
  IDENTITY: "We could not verify your identity.",
  WITHDRAWN: "You withdrew your application.",
  FRAUD: "We could not verify the information in your application.",
  POLICY: "Your application does not meet our lending policy.",
  OTHER: "",
}

const BUREAU_CATEGORIES: ReadonlySet<DeclineCategory> = new Set(["BUREAU_SCORE", "ADVERSE_LISTING", "DEBT_REVIEW"])

/** A decline resting on the credit bureau's record: the client is told which bureau, and how to reach it. */
export function isBureauDeclineCategory(category: DeclineCategory): boolean {
  return BUREAU_CATEGORIES.has(category)
}

export function parseDeclineCategory(value: unknown): DeclineCategory | null {
  return typeof value === "string" && (DECLINE_CATEGORIES as string[]).includes(value)
    ? (value as DeclineCategory)
    : null
}

/** What the client is told: staff's text when given, else the category's. Null when neither exists (Other). */
export function clientDeclineReason(category: DeclineCategory, written: string | null | undefined): string | null {
  const text = written?.trim() || DECLINE_CLIENT_REASONS[category]
  return text || null
}

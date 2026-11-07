/**
 * The home page lines whose catalogue text offers insurance. A lender outside the
 * NCA sells none, so these replace them (English; the catalogue cannot change
 * without resetting every language's native-speaker review, lib/i18n/.claude.md).
 */
export const NON_NCA_HOME_COPY = {
  defaultTagline: "Responsible credit, with the full cost in front of you before you sign.",
  chooseService: "Choose the service you need, then move into eligibility, documents or affordability.",
  readyBody: (brand: string) => `Apply online or check eligibility. ${brand} will guide the next step.`,
} as const

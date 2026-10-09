// Loading a product's live acceptance terms.
//
// The DB half of eligibility; `evaluate.ts` is the pure half. Only
// `active: true` rows are returned — a deactivated rule is configuration
// history, not a live term, and must not satisfy the mandatory-rule check in
// `evaluate.ts`.

import type { Prisma, PrismaClient } from "@prisma/client"
import type { EligibilityRuleInput } from "./evaluate"

export interface LoadEligibilityRulesParams {
  tenantId: string
  productId: string
}

type EligibilityRuleReader = Pick<PrismaClient, "insuranceEligibilityRule">

/** Separated from the call so the query is assertable without a database. */
export function activeEligibilityRulesFindManyArgs({ tenantId, productId }: LoadEligibilityRulesParams) {
  return {
    where: { tenantId, productId, active: true },
    orderBy: [{ ruleType: "asc" }, { lifeScope: "asc" }],
    select: {
      id: true,
      lifeScope: true,
      ruleType: true,
      numericValue: true,
      textValue: true,
      active: true,
    },
  } satisfies Prisma.InsuranceEligibilityRuleFindManyArgs
}

export async function loadEligibilityRules(
  prisma: EligibilityRuleReader,
  params: LoadEligibilityRulesParams,
): Promise<EligibilityRuleInput[]> {
  return prisma.insuranceEligibilityRule.findMany(activeEligibilityRulesFindManyArgs(params))
}

import type { ContractType } from "@prisma/client"
import { ncaInitiationFeeCap } from "@/lib/loan/nca-fee-cap"
import type { RatesDb } from "./rates-store"
import { referenceRateOn } from "./rates-store"

export type NcaAssetContractType = Extract<ContractType, "INSTALMENT_SALE" | "FINANCE_LEASE">

export const NCA_ASSET_CAPS = {
  // Signed off (see DESIGN.md sign-off record 2026-10-17) — Government Notice R1080,
  // Government Gazette 39379 (6 November 2015), Reg 42 table: "Other credit
  // agreements" = RR + 17% per year.
  otherCreditRepoMargin: 0.17,
  // Signed off (see DESIGN.md sign-off record 2026-10-17) — Gazette 39379, Reg 44 table:
  // maximum monthly service fee R60 (VAT treatment to be confirmed).
  monthlyServiceFeeCents: 6_000,
  // Signed off (see DESIGN.md sign-off record 2026-10-17) — Gazette 39379, Reg 42 table:
  // R165 + 10% above R1,000, capped at R1,050, excluding VAT. The shared
  // helper also applies its consumer-protective 15%-of-principal reading.
  initiationFee: "lib/loan/nca-fee-cap.ts",
} as const

export function maxAssetFinanceAnnualRate(_contractType: NcaAssetContractType, repoAnnualRate: number): number {
  return repoAnnualRate + NCA_ASSET_CAPS.otherCreditRepoMargin
}

export const maxAssetFinanceInitiationFeeCents = ncaInitiationFeeCap

export interface NcaCapInput {
  contractType: NcaAssetContractType
  repoAnnualRate: number
  annualRate: number
  principalCents: number
  initiationFeeCents: number
  monthlyServiceFeeCents: number
}

export interface NcaCapProblem {
  field: "annualRate" | "initiationFeeCents" | "monthlyServiceFeeCents"
  message: string
}

export function assetFinanceNcaCapProblems(input: NcaCapInput): NcaCapProblem[] {
  const problems: NcaCapProblem[] = []
  const rateCap = maxAssetFinanceAnnualRate(input.contractType, input.repoAnnualRate)
  if (input.annualRate > rateCap) {
    problems.push({ field: "annualRate", message: `Annual rate exceeds the NCA maximum of ${(rateCap * 100).toFixed(2)}%` })
  }
  const initiationCap = maxAssetFinanceInitiationFeeCents(input.principalCents)
  if (input.initiationFeeCents > initiationCap) {
    problems.push({ field: "initiationFeeCents", message: `Initiation fee exceeds the NCA maximum of ${initiationCap} cents` })
  }
  if (input.monthlyServiceFeeCents > NCA_ASSET_CAPS.monthlyServiceFeeCents) {
    problems.push({ field: "monthlyServiceFeeCents", message: `Monthly service fee exceeds the NCA maximum of ${NCA_ASSET_CAPS.monthlyServiceFeeCents} cents` })
  }
  return problems
}

export async function resolvedAssetFinanceNcaCapProblems(
  db: RatesDb,
  tenantId: string,
  day: string,
  input: Omit<NcaCapInput, "repoAnnualRate">,
): Promise<NcaCapProblem[] | null> {
  const repo = await referenceRateOn(db, tenantId, "REPO", day)
  return repo ? assetFinanceNcaCapProblems({ ...input, repoAnnualRate: repo.rate.toNumber() }) : null
}

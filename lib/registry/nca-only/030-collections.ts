import { defineNcaOnlySurfaces } from "@/lib/jurisdiction/nca-only-registry"

const ELIGIBILITY = { file: "lib/collections/section129-eligibility.ts", contains: 'operation === "SECTION_129" && !isNcaJurisdiction()' } as const

// Section 129 (NCA) and debt review (NCA s86).
export default defineNcaOnlySurfaces({
  "app/api/loans/[id]/section129-reconcile/route.ts": { gate: "direct" },
  "app/api/loans/[id]/section129-recover/route.ts": { gate: "direct" },
  "app/api/loans/[id]/debt-review/route.ts": { gate: "direct" },
  "app/api/loans/section129/route.ts": {
    gate: "via",
    reason: "refuses unless evaluateCollectionsEligibility(loan, \"SECTION_129\") is eligible, which is never for an LS lender",
    proof: [{ file: "app/api/loans/section129/route.ts", contains: 'evaluateCollectionsEligibility(loan, "SECTION_129")' }, ELIGIBILITY],
  },
  "app/api/loans/section129/bulk/route.ts": {
    gate: "via",
    reason: "selects and re-checks every loan with isSection129Eligible, which is evaluateCollectionsEligibility",
    proof: [{ file: "app/api/loans/section129/bulk/route.ts", contains: "isSection129Eligible" }, { file: "lib/collections/section129-eligibility.ts", contains: 'evaluateCollectionsEligibility(loan, "SECTION_129").eligible' }, ELIGIBILITY],
  },
  "app/api/loans/[id]/section129-pdf/route.ts": {
    gate: "via",
    reason: "only serves an artifact issued by the s129 dispatch, which the eligibility check re-runs before it stages; none can exist for an LS lender",
    proof: [{ file: "lib/collections/section129-artifact.ts", contains: 'evaluateCollectionsEligibility(loan, "SECTION_129")' }, ELIGIBILITY],
  },
  "app/api/loans/[id]/attorney-referral/route.ts": {
    gate: "via",
    reason: "requires the loan to have reached SECTION_129_SENT and an issued SECTION_129_NOTICE record, neither of which an LS lender can have (it is not blocked outright: a Lesotho referral route needs its own design)",
    proof: [
      { file: "app/api/loans/[id]/attorney-referral/route.ts", contains: '"SECTION_129_SENT"' },
      { file: "app/api/loans/[id]/attorney-referral/route.ts", contains: 'type: "SECTION_129_NOTICE"' },
      ELIGIBILITY,
    ],
  },
})

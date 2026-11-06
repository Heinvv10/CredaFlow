import { defineNcaOnlySurfaces } from "@/lib/jurisdiction/nca-only-registry"

// The borrower's insurance pages: South African policies (FSCA, the PPR and credit life under the NCA
// regulations). A lender outside the NCA sells none, so the portal has no insurance for its borrowers.
export default defineNcaOnlySurfaces({
  "app/(portal)/portal/insurance/page.tsx": { gate: "direct" },
  "app/(portal)/portal/insurance/[id]/page.tsx": { gate: "direct" },
  "app/api/portal/insurance/policies/[id]/ppr-acknowledge/route.ts": { gate: "direct" },
})

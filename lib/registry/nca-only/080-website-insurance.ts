import { defineNcaOnlySurfaces } from "@/lib/jurisdiction/nca-only-registry"

// The public website's insurance: a FAIS intermediary's offer, South African policies (FSCA, the PPR and credit
// life under the NCA regulations). A lender outside the NCA sells none, so its website has no insurance page,
// quote page or enquiry form to post to.
export default defineNcaOnlySurfaces({
  "app/(website)/site/products/insurance/page.tsx": { gate: "direct" },
  "app/(website)/site/products/insurance/quotes/page.tsx": { gate: "direct" },
  "app/api/website/insurance-enquiry/route.ts": { gate: "direct" },
})

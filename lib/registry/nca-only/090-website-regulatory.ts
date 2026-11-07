import { defineNcaOnlySurfaces } from "@/lib/jurisdiction/nca-only-registry"

// The regulatory-information page prints the lender's NCR and FSCA registrations. A lender outside the NCA holds
// neither. The layout is gated too: it would otherwise print the NCR breadcrumb and FAQ schema around the 404.
export default defineNcaOnlySurfaces({
  "app/(website)/site/regulatory-information/page.tsx": { gate: "direct" },
  "app/(website)/site/regulatory-information/layout.tsx": { gate: "direct" },
})

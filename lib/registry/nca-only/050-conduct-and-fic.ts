import { defineNcaOnlySurfaces } from "@/lib/jurisdiction/nca-only-registry"

// TCF (FSCA conduct) and the FIC Act registers: South African statutes.
// A Lesotho lender has its own anti-money-laundering regime; building that is a
// separate item (see the PR), so these are closed for it rather than left half-right.
export default defineNcaOnlySurfaces({
  "app/api/compliance/tcf/route.ts": { gate: "direct" },
  "app/api/compliance/tcf/[period]/route.ts": { gate: "direct" },
  "app/(dashboard)/compliance/tcf/page.tsx": { gate: "direct" },
  "app/(dashboard)/compliance/fic/page.tsx": { gate: "direct" },
  "app/api/compliance/fic/ctr/route.ts": { gate: "direct" },
  "app/api/compliance/fic/export/route.ts": { gate: "direct" },
  "app/api/compliance/fic/rmcp/route.ts": { gate: "direct" },
  "app/api/compliance/fic/rmcp/[id]/route.ts": { gate: "direct" },
  "app/api/compliance/fic/str/route.ts": { gate: "direct" },
  "app/api/compliance/fic/str/[id]/route.ts": { gate: "direct" },
})

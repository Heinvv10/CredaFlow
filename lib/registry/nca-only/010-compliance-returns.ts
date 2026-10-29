import { defineNcaOnlySurfaces } from "@/lib/jurisdiction/nca-only-registry"

// Statutory returns to the NCR and FSCA: South African regulators.
export default defineNcaOnlySurfaces({
  "app/api/compliance/ncr-return/route.ts": { gate: "direct" },
  "app/(dashboard)/compliance/ncr-return/page.tsx": { gate: "direct" },
  "app/api/compliance/fsca-return/route.ts": { gate: "direct" },
  "app/(dashboard)/compliance/fsca-return/page.tsx": { gate: "direct" },
  // The export route serves many report types; ncr-quarterly, section129-log and
  // both FSCA types return ncaOnlyRefusal inside their own branch.
  "app/api/reports/export/route.ts": { gate: "direct" },
})

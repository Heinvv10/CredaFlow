import { defineNcaOnlySurfaces } from "@/lib/jurisdiction/nca-only-registry"

// The SARB repo rate and reference rates feed the NCA interest cap and asset finance.
export default defineNcaOnlySurfaces({
  "app/(dashboard)/settings/repo-rate/page.tsx": { gate: "direct" },
  "app/api/asset-finance/reference-rates/route.ts": { gate: "direct" },
  "app/api/asset-finance/reference-rates/[id]/decide/route.ts": { gate: "direct" },
  "app/api/cron/reference-rate-feed/route.ts": { gate: "direct" },
})

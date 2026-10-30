import { defineNcaOnlySurfaces } from "@/lib/jurisdiction/nca-only-registry"

// Asset finance is an NCA product; its crons skip for a lender outside the NCA's
// jurisdiction (the module's other routes are covered by the structural census).
export default defineNcaOnlySurfaces({
  "app/api/cron/asset-finance-dealer-draft-purge/route.ts": { gate: "direct" },
  "app/api/cron/asset-finance-lease-invoices/route.ts": { gate: "direct" },
  "app/api/cron/asset-finance-rate-notices/route.ts": { gate: "direct" },
  "app/api/cron/asset-finance-recovery-deadlines/route.ts": { gate: "direct" },
  "app/api/cron/asset-finance-reprice/route.ts": { gate: "direct" },
  "app/api/cron/asset-finance-telematics-closure/route.ts": { gate: "direct" },
  "app/api/cron/asset-finance-telematics-poll/route.ts": { gate: "direct" },
  "app/api/cron/asset-finance-telematics-purge/route.ts": { gate: "direct" },
})

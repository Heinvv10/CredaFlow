import { DAY, HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // Asset finance: re-solves reference-linked contracts for reference-rate
  // changes that took effect (lib/asset-finance/reprice-batch.ts). Idempotent
  // per (loan, effective date); idle for tenants without featureAssetFinance.
  { route: "asset-finance-reprice", owner: "in-process", schedule: "45 1 * * *", freshnessMinutes: DAY + 2 * HOUR },
  // Asset-finance leases: the tax invoice of every rental that fell due
  // (lib/asset-finance/lease-invoice-batch.ts). After the repricing run, so a
  // rental repriced today is invoiced at its new amount. Idempotent.
  { route: "asset-finance-lease-invoices", owner: "in-process", schedule: "15 2 * * *", freshnessMinutes: DAY + 2 * HOUR },
] as const)

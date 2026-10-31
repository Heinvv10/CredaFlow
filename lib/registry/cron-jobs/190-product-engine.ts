import { DAY, HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // Product versions that came into effect (lib/product-engine/activate.ts): shortly after SAST midnight, makes LoanProduct
  // equal the version in effect for each product. Idempotent (a version is stamped applied once) and sends nothing, so
  // every replica runs it; a missed night is made up the next, and approval prices on the version in effect either way.
  { route: "product-version-activate", owner: "in-process", schedule: "10 0 * * *", freshnessMinutes: DAY + 2 * HOUR },
] as const)

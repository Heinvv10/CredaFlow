/**
 * Itemised monthly budget for a seeded client, split from that client's own
 * stated monthly expenses. The itemised total must equal the stated figure
 * (lib/affordability/snapshot.ts), otherwise the public website apply route
 * refuses the client with "scalar and itemised expense evidence is inconsistent".
 */
const SHARES_PERCENT = {
  housing: 37,
  transport: 14,
  food: 21,
  education: 5,
  insurance: 7,
  clothing: 5,
  entertainment: 3,
  medical: 3,
} as const

// "other" carries the remaining 5%, so the named shares must total 95.
if (Object.values(SHARES_PERCENT).reduce((sum, pct) => sum + pct, 0) !== 95) {
  throw new Error("seed expense shares must total 95 percent")
}

export type SeedExpenseBreakdown = Record<keyof typeof SHARES_PERCENT | "other", number>

export function seedExpenseBreakdown(monthlyExpensesCents: number): SeedExpenseBreakdown {
  const parts = Object.fromEntries(
    Object.entries(SHARES_PERCENT).map(([key, pct]) => [key, Math.floor((monthlyExpensesCents * pct) / 100)]),
  ) as Omit<SeedExpenseBreakdown, "other">
  const allocated = Object.values(parts).reduce((sum, cents) => sum + cents, 0)
  // "other" takes the remaining 5% plus any rounding remainder.
  return { ...parts, other: monthlyExpensesCents - allocated }
}

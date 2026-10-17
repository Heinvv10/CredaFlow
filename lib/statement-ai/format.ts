/** "R1 234.56", "-R45.00": the one way an amount is written to the model and read back by the post-check. */
export function rand(cents: number): string {
  const sign = cents < 0 ? "-" : ""
  const abs = Math.abs(Math.round(cents))
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  return `${sign}R${whole}.${String(abs % 100).padStart(2, "0")}`
}

/** A share as a percentage with one decimal: 0.1234 → 12.3. */
export const pct = (share: number) => Math.round(share * 1000) / 10

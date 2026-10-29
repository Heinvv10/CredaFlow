import type { Currency } from "./profiles"

/**
 * The house money format, per currency: symbol, a space, comma-grouped, two
 * decimals ("R 1,234.56", "M 1,234.56"). One spelling in every surface, so the
 * amount on screen is character-for-character the amount on a PDF or SMS.
 * ZAR output is unchanged since the first release.
 */
const SYMBOL: Record<Currency, string> = { ZAR: "R", LSL: "M" }

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")

/** The symbol of `currency` ("R", "M"), for the few formatters with a shape of their own. */
export function currencySymbol(currency: Currency): string {
  return SYMBOL[currency]
}

/** The sign to print before the symbol: "-" for a negative amount that does not round to zero. */
const signOf = (value: number, printed: string) => (value < 0 && /[1-9]/.test(printed) ? "-" : "")

/** `cents` of `currency`, e.g. 123456 -> "R 1,234.56"; a negative amount leads with the sign: "-R 0.05". */
export function formatMoney(cents: number, currency: Currency): string {
  const printed = group(Math.abs(cents / 100).toFixed(2))
  return `${signOf(cents, printed)}${SYMBOL[currency]} ${printed}`
}

/** A value held in whole units (form state), cents dropped: "R 1,000,000". */
export function formatMoneyWhole(units: number, currency: Currency): string {
  const printed = group(Math.abs(Math.round(units)).toString())
  return `${signOf(units, printed)}${SYMBOL[currency]} ${printed}`
}

/**
 * Abbreviated from CENTS for KPI cards: "R2.5m", "M123k", else the full format.
 * Thousands round first and a figure that rounds up to 1000k is shown in
 * millions ("R1.0m"), never "R1000k".
 */
export function formatMoneyCompact(cents: number, currency: Currency): string {
  const units = Math.abs(cents / 100)
  const sign = cents < 0 ? "-" : ""
  const symbol = SYMBOL[currency]
  if (units >= 1_000_000 || Math.round(units / 1_000) >= 1_000) return `${sign}${symbol}${(units / 1_000_000).toFixed(1)}m`
  if (units >= 1_000) return `${sign}${symbol}${(units / 1_000).toFixed(0)}k`
  return formatMoney(cents, currency)
}

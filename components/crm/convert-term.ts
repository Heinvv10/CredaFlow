export type TermBounds = { minTermDays: number; maxTermDays: number }

export function isFixedTerm(product: TermBounds): boolean {
  return product.minTermDays === product.maxTermDays
}

/** Variable-term products start empty so the term is a deliberate choice. */
export function defaultTermInput(product: TermBounds): string {
  return isFixedTerm(product) ? String(product.minTermDays) : ""
}

/** True for a variable-term product whose entered term the server would reject. */
export function termIsInvalid(product: TermBounds, input: string): boolean {
  if (isFixedTerm(product)) return false
  const n = input.trim() === "" ? NaN : Number(input)
  return !Number.isInteger(n) || n < product.minTermDays || n > product.maxTermDays
}

/** Fixed-term products omit the term; the server uses the product's own. */
export function termForRequest(product: TermBounds | undefined, input: string): number | undefined {
  if (!product || isFixedTerm(product)) return undefined
  return Number(input)
}

/** The convert button is blocked while loading or a variable-term product has no valid term. */
export function convertBlocked(product: TermBounds | undefined, input: string, loading: boolean): boolean {
  return loading || (!!product && termIsInvalid(product, input))
}

// The {{tokens}} a lender's asset-finance wording may use. Every value is
// system data (the lender identity or the deal), never typed by the lender, so
// a template cannot print a figure the deal does not hold.

export const ASSET_TEMPLATE_TOKENS = {
  "lender.legalName": "The lender's registered name",
  "lender.tradingName": "The lender's trading name",
  "lender.registeredOffice": "The lender's registered office, on one line",
  "agreement.reference": "The agreement reference",
  "purchaser.domicilium": "The purchaser's chosen address for notices (instalment sale clause 7.12 only)",
} as const

export type AssetTemplateToken = keyof typeof ASSET_TEMPLATE_TOKENS

const TOKEN = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g

/** The token names a text uses, in order of first use. */
export function tokensIn(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN)].map((m) => m[1]))]
}

/** Braces that are not part of a well-formed {{token}}. */
export function hasStrayBraces(text: string): boolean {
  return /[{}]/.test(text.replace(TOKEN, ""))
}

/**
 * Replace each {{token}} with its value. A token without a value throws: the
 * validator refuses unknown tokens first, so this is a programming error.
 */
export function fillTokens(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(TOKEN, (_, name: string) => {
    const value = values[name]
    if (value === undefined) throw new RangeError(`No value for the template token {{${name}}}`)
    return value
  })
}

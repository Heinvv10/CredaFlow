// The introducer (a dealer or broker) is printed on the asset-finance
// documents as a labelled field, "Introducer: <name> (dealer)", beside the
// commission disclosure (./commission-disclosure.ts), whose own wording is fixed
// and never contains the name. So the name is data, like the supplier's: it
// needs only to be printable text, not a vetted phrase. Checked when staff
// write the name (lib/dealer/staff-dealers.ts) and again whenever a document is
// built, for names written before the rule.
import { winAnsiSafe } from "@/lib/pdf/executed-agreement"

export const MAX_DEALER_NAME = 80

/** The dealer or broker that introduced the deal, as the documents print it. */
export interface DocumentDealer {
  name: string
  kind: "DEALER" | "BROKER"
}

// Control characters (C0, DEL, C1), the no-break space and the soft hyphen are
// inside the document font's range but print as nothing or as a lookalike.
const HIDDEN = /[\u0000-\u001F\u007F- ­]/

/** Why `name` may not be printed on a document, or null when it may. */
export function dealerNameProblem(name: string): string | null {
  if (name.length === 0 || name.length > MAX_DEALER_NAME) return `must be 1 to ${MAX_DEALER_NAME} characters`
  if (name !== name.trim() || name.includes("  ")) return "must have no leading, trailing or repeated spaces"
  if (HIDDEN.test(name) || winAnsiSafe(name) !== name) {
    return "may use only characters the document font can print: no line breaks, tabs, control, invisible or non-Latin characters"
  }
  return null
}

/** For staff: why a document for a deal introduced by `name` cannot be built, or null when it can. */
export function dealerPrintRefusal(name: string): string | null {
  const problem = dealerNameProblem(name)
  // Quoted with every non-ASCII character escaped, so the message shows what is wrong with the name.
  const shown = JSON.stringify(name).replace(/[\u007F-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
  return problem && `The introducer's name ${shown} cannot be printed on the document: it ${problem}. Edit the dealer's name, then try again.`
}

/** A stored dealer as the documents carry it; none when the deal has no dealer. */
export function documentDealer(row: { name: string; kind: "DEALER" | "BROKER" } | null | undefined): DocumentDealer | null {
  return row ? { name: row.name, kind: row.kind } : null
}

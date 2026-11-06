// The regulator's approval reference of a loan product, as the loan-product API and a proposal receive it.
// Kenya: the Central Bank of Kenya's product approval, printed on the key facts statement
// ({{product.regulatorApprovalRef}}, lib/documents/tokens.ts). Outside the NCA only: a South African
// product has none, so a value there is refused. Absent leaves the stored value unchanged; null or
// blank clears it. Letters, digits and / . - _ or spaces, starting with a letter or digit, at most 64.

import { isNcaJurisdiction } from "@/lib/jurisdiction/active"

export interface RegulatorApprovalRefField {
  regulatorApprovalRef?: string | null
}

const REF = /^[A-Za-z0-9][A-Za-z0-9/._ -]{0,63}$/

export function parseRegulatorApprovalRef(body: Record<string, unknown>): { data: RegulatorApprovalRefField } | { issues: string[] } {
  if (!("regulatorApprovalRef" in body)) return { data: {} }
  const raw = body.regulatorApprovalRef
  if (raw === null || (typeof raw === "string" && raw.trim() === "")) return { data: { regulatorApprovalRef: null } }
  if (typeof raw !== "string" || !REF.test(raw.trim()) || isNcaJurisdiction()) return { issues: ["regulatorApprovalRef"] }
  return { data: { regulatorApprovalRef: raw.trim() } }
}

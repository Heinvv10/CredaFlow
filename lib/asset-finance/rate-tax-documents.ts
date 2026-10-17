/** Immutable s21 written particulars delivered with the rate-change notice.
 * Amounts describe the credit/debit, never an executed cash refund. */
export interface RateTaxDocument {
  kind: "CREDIT_NOTE" | "DEBIT_NOTE"
  id: string
  invoiceId: string
  periodNo: number
  number: string
  originalInvoiceNumber: string
  issueDate: string
  reason: string
  supplierName: string
  supplierAddress: string
  supplierVatNumber: string
  recipientName: string
  recipientAddress: string
  recipientVatNumber: string | null
  vatRate: string
  exclVatCents: number
  vatCents: number
  inclVatCents: number
}
export function rateTaxDocuments(value: unknown): RateTaxDocument[] {
  if (!Array.isArray(value)) return []
  return value.filter((x): x is RateTaxDocument => x && typeof x === "object" && ["CREDIT_NOTE","DEBIT_NOTE"].includes(x.kind) && ["id","invoiceId","number","originalInvoiceNumber","issueDate","reason","supplierName","supplierAddress","supplierVatNumber","recipientName","recipientAddress","vatRate"].every(k=>typeof x[k]==="string") && ["exclVatCents","vatCents","inclVatCents"].every(k=>Number.isSafeInteger(x[k])))
}
export function rateTaxDocumentText(doc: RateTaxDocument): string {
  const money=(n:number)=>`R${(Math.abs(n)/100).toFixed(2)}`
  return `${doc.kind === "CREDIT_NOTE" ? "CREDIT NOTE" : "DEBIT NOTE"} ${doc.number}; issued ${doc.issueDate}. Supplier: ${doc.supplierName}; ${doc.supplierAddress}; VAT ${doc.supplierVatNumber}. Recipient: ${doc.recipientName}; ${doc.recipientAddress}${doc.recipientVatNumber ? `; VAT ${doc.recipientVatNumber}` : ""}. Original transaction: tax invoice ${doc.originalInvoiceNumber}. Reason: ${doc.reason}. Adjustment value excluding VAT: ${money(doc.exclVatCents)}; VAT at ${Number(doc.vatRate)*100}%: ${money(doc.vatCents)}; total adjustment including VAT: ${money(doc.inclVatCents)}.`
}

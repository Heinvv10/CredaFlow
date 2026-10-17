import { rateTaxDocuments } from "@/lib/asset-finance/rate-tax-documents"
import { prisma } from "@/lib/prisma"
import { formatMoney } from "@/lib/asset-finance/format"

export async function RateCorrectionPanel({ tenantId, loanId, status }: { tenantId: string; loanId: string; status: string }) {
  const corrections = await prisma.assetFinanceRateCorrection.findMany({ where: { tenantId, loanId }, orderBy: { createdAt: "asc" } })
  if (!corrections.length) return null
  const amount = corrections.reduce((sum, row) => sum + row.amountCents, 0)
  if (amount === 0) return null
  const documents = corrections.flatMap(row => { const value = row.contractualRows; return value && typeof value === "object" && !Array.isArray(value) ? rateTaxDocuments(value.taxDocuments) : [] })
  return <section className="rounded-lg border p-4" aria-label="Pending rate correction">
    <h2 className="font-semibold">Rate correction pending manual execution</h2>
    <p>{amount < 0 ? status === "COMPLETED" ? "Refund due to borrower" : "Credit to borrower" : "Additional amount due from borrower"}: {formatMoney(Math.abs(amount))}</p>
    <p>Recorded cash payments are preserved in total. No refund or debit has been executed. Reconcile this separate adjustment before collecting or releasing money.</p>
    {documents.map(doc => <p key={doc.id}><a className="underline" href={`/api/asset-finance/${doc.kind === "CREDIT_NOTE" ? "credit-notes" : "tax-invoices"}/${doc.id}`}>{doc.kind === "CREDIT_NOTE" ? "Credit note" : "Debit note"} {doc.number}</a></p>)}
  </section>
}

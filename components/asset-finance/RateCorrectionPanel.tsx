import { prisma } from "@/lib/prisma"
import { formatMoney } from "@/lib/asset-finance/format"

export async function RateCorrectionPanel({ tenantId, loanId }: { tenantId: string; loanId: string }) {
  const corrections = await prisma.assetFinanceRateCorrection.findMany({ where: { tenantId, loanId }, orderBy: { createdAt: "asc" } })
  if (!corrections.length) return null
  const amount = corrections.reduce((sum, row) => sum + row.amountCents, 0)
  return <section className="rounded-lg border p-4" aria-label="Pending rate correction">
    <h2 className="font-semibold">Rate correction pending manual execution</h2>
    <p>{amount < 0 ? "Refund due to borrower" : "Additional amount due from borrower"}: {formatMoney(Math.abs(amount))}</p>
    <p>Original receipts are unchanged. No refund or debit has been executed. Reconcile this separate adjustment before collecting or releasing money.</p>
  </section>
}

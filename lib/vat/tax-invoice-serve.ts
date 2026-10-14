// Serves an issued tax invoice as a PDF. The invoice carries the recipient's
// name, address and VAT number, so a read is logged in DocumentAccessLog
// (documentId = the invoice id) BEFORE the PDF is rendered, like every
// document read (lib/document-auth.ts). The caller has decided the accessor
// may read this tenant's invoice; the lookup is scoped to the tenant.
import { NextResponse } from "next/server"
import type { prisma } from "@/lib/prisma"
import { logDocumentAccess } from "@/lib/document-auth"
import { generateTaxInvoicePdf } from "./tax-invoice-pdf"

type ServeDb = Pick<typeof prisma, "taxInvoice" | "documentAccessLog">

/** The PDF response, or null when the tenant has no such invoice. */
export async function serveTaxInvoicePdf(
  db: ServeDb,
  req: Request,
  target: { tenantId: string; invoiceId: string },
  accessor: { type: "staff" | "client"; id: string },
): Promise<NextResponse | null> {
  const invoice = await db.taxInvoice.findFirst({
    where: { id: target.invoiceId, tenantId: target.tenantId },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  })
  if (!invoice) return null
  const isDownload = new URL(req.url).searchParams.get("download") === "1"
  await logDocumentAccess(db, {
    documentId: invoice.id, accessorType: accessor.type, accessorId: accessor.id, action: isDownload ? "download" : "view", req,
  })
  const pdf = await generateTaxInvoicePdf(invoice)
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${isDownload ? "attachment" : "inline"}; filename="tax-invoice-${invoice.invoiceNumber}.pdf"`,
      "Content-Length": String(pdf.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

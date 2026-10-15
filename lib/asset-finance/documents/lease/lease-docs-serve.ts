// Serves the three lease servicing documents (slice 3, C9) as PDFs, for the
// staff route and the portal route alike. The caller has already decided the
// accessor may read this lease (staff role, or the lessee's portal gate).
// The read is logged in DocumentAccessLog BEFORE rendering, like every
// document read (lib/document-auth.ts); nothing leaves without its row.
import { NextResponse } from "next/server"
import type { prisma } from "@/lib/prisma"
import { logDocumentAccess } from "@/lib/document-auth"
import { lenderIdentityOrRefusal } from "@/lib/config/identity-response"
import { renderLeaseExpiryNotice } from "./expiry-notice-pdf"
import { renderLeaseInspectionReport } from "./inspection-report-pdf"
import { loadExpiryNotice, loadInspectionReport, loadTerminationQuote, type LeaseDocsDb } from "./lease-docs-loader"
import { renderLeaseTerminationQuote } from "./termination-quote-pdf"

export const LEASE_DOCUMENT_KINDS = ["expiry-notice", "termination-quote", "inspection-report"] as const
export type LeaseDocumentKind = (typeof LEASE_DOCUMENT_KINDS)[number]

export const isLeaseDocumentKind = (value: string): value is LeaseDocumentKind => (LEASE_DOCUMENT_KINDS as readonly string[]).includes(value)

type ServeDb = LeaseDocsDb & Pick<typeof prisma, "documentAccessLog">

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 })

/** The entity a refused read is audited against (the portal wrapper's target). */
export const leaseDocumentTarget = (loanId: string) => ({ entity: "Loan", entityId: loanId })

/**
 * The PDF response; 400 for a quote request without its `quoteId`; 404 when the
 * lease has no such row; 409 when the lender's identity is not configured.
 * `?download=1` serves an attachment (logged as a download), else inline (a view).
 */
export async function serveLeaseDocument(
  db: ServeDb,
  req: Request,
  target: { tenantId: string; loanId: string; kind: LeaseDocumentKind },
  accessor: { type: "staff" | "client"; id: string },
): Promise<NextResponse> {
  const { tenantId, loanId, kind } = target
  const params = new URL(req.url).searchParams
  const quoteId = params.get("quoteId")
  if (kind === "termination-quote" && !quoteId) return NextResponse.json({ error: "quoteId is required" }, { status: 400 })

  const data =
    kind === "expiry-notice" ? await loadExpiryNotice(db, tenantId, loanId)
    : kind === "termination-quote" ? await loadTerminationQuote(db, tenantId, loanId, quoteId ?? "")
    : await loadInspectionReport(db, tenantId, loanId)
  if (!data) return notFound()
  const lender = await lenderIdentityOrRefusal(tenantId)
  if (lender.refusal) return lender.refusal

  const download = params.get("download") === "1"
  const documentId = "noticeId" in data ? data.noticeId : "quoteId" in data ? data.quoteId : data.endOfTermId
  await logDocumentAccess(db, { documentId, accessorType: accessor.type, accessorId: accessor.id, action: download ? "download" : "view", req })
  const bytes =
    "noticeId" in data ? await renderLeaseExpiryNotice(data, lender.identity)
    : "quoteId" in data ? await renderLeaseTerminationQuote(data, lender.identity)
    : await renderLeaseInspectionReport(data, lender.identity)
  const filename = `lease-${kind}-${data.reference}.pdf`.replace(/[^A-Za-z0-9._-]+/g, "-")
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

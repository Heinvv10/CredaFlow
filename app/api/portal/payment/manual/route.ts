import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { saveFile, deleteFile } from "@/lib/storage"
import { MAX_FILE_SIZE } from "@/lib/document-auth"
import { logAudit, AuditAction } from "@/lib/audit"
import { callerIp, checkRateLimit } from "@/lib/rate-limit"
import { owesNothing } from "@/lib/loan/charges-summary"
import { recordPaymentNotification } from "@/lib/payments/payment-notifications"

// Proof of payment accepts PDF/JPEG/PNG only (matches the form's accept attr).
// Narrower than document-auth's ALLOWED_MIME_TYPES, which also permits webp.
const PROOF_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"]

// Verify real file content matches the declared MIME (defence vs. spoofed Content-Type).
const MAGIC: Record<string, number[][]> = {
  "application/pdf": [[0x25, 0x50, 0x44, 0x46]],            // %PDF
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
}
function matchesMagic(head: Uint8Array, mime: string): boolean {
  const sigs = MAGIC[mime] ?? []
  return sigs.some((sig) => sig.every((b, i) => head[i] === b))
}

// Each report stores a file and rings every reconciling staff member's bell,
// so a client is held to a handful an hour (a few payments plus retries).
const NOTIFY_RATE_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 } as const

/** A real calendar day as YYYY-MM-DD (2026-02-31 is not one). */
function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const gate = await checkRateLimit(`portal:payment-notify:${session.user.email}`, NOTIFY_RATE_LIMIT)
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "Too many payment notifications. Please try again later or contact us." },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } },
    )
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 })
  }

  const file = form.get("file")
  const loanId = form.get("loanId")
  const amountRaw = form.get("amount")
  const reference = form.get("reference")
  const paymentDate = form.get("paymentDate")
  const notes = form.get("notes")

  const amount = typeof amountRaw === "string" && /^\d+$/.test(amountRaw) ? Number(amountRaw) : NaN
  if (typeof loanId !== "string" || !loanId || isNaN(amount) || amount <= 0 || amount > 1_000_000_000) {
    return NextResponse.json({ error: "loanId and amount are required" }, { status: 400 })
  }

  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Proof of payment file is required" }, { status: 400 })
  }
  if (!PROOF_MIME_TYPES.includes(file.type)) {
    return NextResponse.json({ error: "File type not allowed. Accepted: PDF, JPEG, PNG" }, { status: 400 })
  }
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "File too large. Maximum 10MB" }, { status: 400 })
  }

  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  if (!matchesMagic(head, file.type)) {
    return NextResponse.json({ error: "File content does not match its type" }, { status: 400 })
  }

  if (typeof paymentDate === "string" && paymentDate && !isCalendarDay(paymentDate)) {
    return NextResponse.json({ error: "Invalid payment date" }, { status: 400 })
  }

  if (typeof reference === "string" && reference.length > 200) {
    return NextResponse.json({ error: "Reference is too long" }, { status: 400 })
  }
  if (typeof notes === "string" && notes.length > 2000) {
    return NextResponse.json({ error: "Notes are too long" }, { status: 400 })
  }

  // Sanitise the client-supplied filename before it lands in the DB, note, and audit.
  const safeName = ((file.name.split(/[\\/]/).pop() ?? "proof").replace(/[^\w.\-() ]/g, "_").trim().slice(0, 255)) || "proof"

  return withTenantContext(req, async (tenant) => {
    const tenantId = tenant.id

    const client = await prisma.client.findFirst({
      where: { email: session.user.email, tenantId },
      select: { id: true, firstName: true, lastName: true },
    })
    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 })
    }

    const loan = await prisma.loan.findFirst({
      where: { id: loanId, clientId: client.id, tenantId },
      select: { id: true, reference: true, status: true },
    })
    if (!loan) {
      return NextResponse.json({ error: "Loan not found" }, { status: 404 })
    }
    if (owesNothing(loan)) {
      return NextResponse.json({ error: "This loan was cancelled and nothing is owed on it" }, { status: 409 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    // saveFile (disk write) stays OUTSIDE the tx; on tx failure we delete it.
    const { storagePath, fileSize } = await saveFile(buffer, file.type)

    let doc: { id: string }
    try {
      // Document + linking note are written atomically: a retained POPIA
      // ClientDocument must never exist without its manual_payment_claim note.
      // The claim itself is an item awaiting reconciliation on the Payments
      // page, with a bell item for the staff who reconcile, in the same commit.
      // Retained, POPIA-access-logged proof. Skip VLM extraction — a bank slip
      // is not a KYC doc and validating it against client fields is just noise.
      doc = await prisma.$transaction(async (tx) => {
        const created = await tx.clientDocument.create({
          data: {
            tenantId,
            clientId: client.id,
            docType: "PROOF_OF_PAYMENT",
            fileUrl: "",
            fileName: safeName,
            mimeType: file.type,
            fileSize,
            storagePath,
            uploadedByType: "client",
            uploadedById: client.id,
            extractionStatus: "skipped",
          },
        })

        await tx.loanNote.create({
          data: {
            tenantId,
            loanId: loan.id,
            type: "manual_payment_claim",
            documentId: created.id,
            note: [
              `[PORTAL] Client reported manual payment:`,
              `Amount: R${(amount / 100).toFixed(2)}`,
              typeof reference === "string" && reference ? `Reference: ${reference}` : "",
              typeof paymentDate === "string" && paymentDate ? `Payment Date: ${paymentDate}` : "",
              typeof notes === "string" && notes ? `Notes: ${notes}` : "",
              `Proof of payment: ${safeName}`,
              `Client: ${client.firstName} ${client.lastName}`,
            ].filter(Boolean).join("\n"),
            createdBy: `client:${client.id}`,
          },
        })

        await recordPaymentNotification(tx, {
          tenantId,
          loanId: loan.id,
          loanReference: loan.reference,
          clientId: client.id,
          clientName: `${client.firstName} ${client.lastName}`,
          amount,
          reference: typeof reference === "string" && reference ? reference : null,
          // The SAST calendar day the client named, at SAST midnight.
          paymentDate: typeof paymentDate === "string" && paymentDate ? new Date(`${paymentDate}T00:00:00+02:00`) : null,
          notes: typeof notes === "string" && notes ? notes : null,
          documentId: created.id,
          actorEmail: session.user.email ?? null,
          ipAddress: callerIp(req),
        })

        return created
      })
    } catch (err) {
      // Tx rolled back — drop the orphaned on-disk file (deleteFile swallows ENOENT).
      await deleteFile(storagePath).catch(() => undefined)
      throw err
    }

    await logAudit({
      tenantId,
      userEmail: session.user.email ?? undefined,
      action: AuditAction.DOCUMENT_UPLOADED,
      entity: "ClientDocument",
      entityId: doc.id,
      newValue: {
        docType: "PROOF_OF_PAYMENT",
        clientId: client.id,
        loanId: loan.id,
        loanReference: loan.reference,
        amountCents: amount,
        fileName: safeName,
      },
      ipAddress: callerIp(req),
    })

    return NextResponse.json({ ok: true, message: "Payment notification submitted for admin review." })
  })
}

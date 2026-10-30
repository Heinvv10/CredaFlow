import { keyFactsRefusal } from "@/lib/non-nca-documents/refusal"
import { NextResponse, type NextRequest } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { readFile } from "@/lib/storage"
import {
  documentBytesMatchSha256,
  isSha256Digest,
} from "@/lib/documents/content-integrity"
import { createSigningPacketPdf } from "@/lib/pdf/signingPacket"
import { sendEmail } from "@/lib/email/service"
import { getLenderIdentity } from "@/lib/config/identity"
import { escapeHtml } from "@/lib/utils"
import { AuditAction, logAudit } from "@/lib/audit"
import { recordedCallerIp } from "@/lib/rate-limit"
import { maskDestination } from "@/lib/compliance/pasq-link-token.server"
import { portalContinueUrl } from "@/lib/portal-urls"
import { EntityBorrowerError, hasClientBorrower } from "@/lib/borrower"
import { DEALER_CONTACT_UNVERIFIED, dealerContactUnverified } from "@/lib/clients/dealer-contact"

type RouteCtx = { params: Promise<{ id: string }> }
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(req: NextRequest, { params }: RouteCtx) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const keyFactsRefusedNew = await keyFactsRefusal(tenant.id, id)
    if (keyFactsRefusedNew) return keyFactsRefusedNew
    const application = await prisma.loanApplication.findUnique({
      where: { id, tenantId: tenant.id },
      select: {
        clientId: true,
        reference: true,
        status: true,
        agreementSignedAt: true,
        pasqDocumentId: true,
        pasqDocumentSha256: true,
        agreementDocumentId: true,
        agreementDocumentSha256: true,
        client: {
          select: {
            email: true,
            firstName: true,
            lastName: true,
            createdByDealerId: true,
            dealerContactVerifiedAt: true,
          },
        },
      },
    })
    if (!application) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 })
    }
    // The signing packet holds consumer NCA documents; an entity borrower is refused.
    if (!hasClientBorrower(application)) {
      return NextResponse.json({ error: new EntityBorrowerError().message }, { status: 409 })
    }
    // Contact details a dealer typed may be the dealer's own: nothing goes to
    // them until a staff member verifies them (lib/clients/dealer-contact.ts).
    if (dealerContactUnverified(application.client)) {
      return NextResponse.json({ error: DEALER_CONTACT_UNVERIFIED }, { status: 409 })
    }
    if (
      application.status !== "APPROVED"
      || application.agreementSignedAt
      || !application.pasqDocumentId
      || !application.agreementDocumentId
      || !isSha256Digest(application.pasqDocumentSha256)
      || !isSha256Digest(application.agreementDocumentSha256)
    ) {
      return NextResponse.json(
        { error: "Prepare the unsigned PASQ and credit agreement packet before emailing it." },
        { status: 409 },
      )
    }
    const sentTo = application.client.email
    if (!sentTo || !EMAIL_SHAPE.test(sentTo)) {
      return NextResponse.json(
        { error: "The client record has no valid email address." },
        { status: 422 },
      )
    }

    const [pasqDocument, agreementDocument] = await Promise.all([
      prisma.clientDocument.findFirst({
        where: {
          id: application.pasqDocumentId,
          tenantId: tenant.id,
          clientId: application.clientId,
          docType: "FORM_20_PRE_AGREEMENT",
          deletedAt: null,
          contentSha256: application.pasqDocumentSha256,
          storagePath: { not: null },
        },
      }),
      prisma.clientDocument.findFirst({
        where: {
          id: application.agreementDocumentId,
          tenantId: tenant.id,
          clientId: application.clientId,
          docType: "CREDIT_AGREEMENT",
          deletedAt: null,
          contentSha256: application.agreementDocumentSha256,
          storagePath: { not: null },
        },
      }),
    ])
    if (!pasqDocument?.storagePath || !agreementDocument?.storagePath) {
      return NextResponse.json(
        { error: "One or more signing-packet documents are unavailable." },
        { status: 422 },
      )
    }

    let pasqBytes: Buffer
    let agreementBytes: Buffer
    try {
      ;[pasqBytes, agreementBytes] = await Promise.all([
        readFile(pasqDocument.storagePath),
        readFile(agreementDocument.storagePath),
      ])
    } catch {
      return NextResponse.json(
        { error: "One or more signing-packet files are unavailable." },
        { status: 422 },
      )
    }
    if (
      !documentBytesMatchSha256(pasqBytes, application.pasqDocumentSha256)
      || !documentBytesMatchSha256(
        agreementBytes,
        application.agreementDocumentSha256,
      )
    ) {
      return NextResponse.json(
        { error: "A signing-packet document failed its integrity check." },
        { status: 422 },
      )
    }

    const packet = await createSigningPacketPdf(pasqBytes, agreementBytes)
    // /portal/continue, not a bare deep link: the consumer may not have a portal
    // account yet (staff-captured applications never create one), and a deep
    // link would land them on a login page with no way forward. This resolves
    // login-vs-register at CLICK time and carries the destination through both.
    const signingUrl = portalContinueUrl(
      sentTo,
      application.reference,
      `/portal/agreement/${id}`,
    )
    const clientName = [
      application.client.firstName,
      application.client.lastName,
    ].filter(Boolean).join(" ")
    const identity = await getLenderIdentity(tenant.id)
    const delivery = await sendEmail({
      tenantId: tenant.id,
      to: sentTo,
      toName: clientName || undefined,
      subject: `PASQ and credit agreement for signature — ${application.reference}`,
      html: [
        `<p>Good day${clientName ? ` ${escapeHtml(clientName)}` : ""},</p>`,
        "<p>Attached is your Pre-Agreement Statement and Quotation followed by your credit agreement in one PDF.</p>",
        "<p>Please review the PASQ first, then the credit agreement. You can sign it online using the button below, or sign the attached packet and return it to your consultant.</p>",
        `<p><a href="${signingUrl}" style="display:inline-block;background:#4F46E5;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:bold;font-size:14px;letter-spacing:0.5px;">Sign my agreement</a></p>`,
        `<p>${escapeHtml(identity.tradingName)}</p>`,
      ].join("\n"),
      text: `Attached is the PASQ and credit agreement signing packet for application ${application.reference}. Review the PASQ first, then the agreement. Sign online at ${signingUrl}, or sign the attached packet and return it to your consultant.`,
      category: "agreement-signing-packet",
      referenceId: id,
      attachments: [{
        filename: `pasq-credit-agreement-${application.reference}.pdf`,
        content: Buffer.from(packet),
        contentType: "application/pdf",
      }],
    })

    const possiblyDelivered =
      delivery.ok || delivery.providerOutcome !== "DEFINITELY_REJECTED"
    if (possiblyDelivered) {
      await prisma.$transaction([
        prisma.documentAccessLog.create({
          data: {
            documentId: pasqDocument.id,
            accessorType: "staff",
            accessorId: guard.user.id,
            action: "email_in_signing_packet",
            ipAddress: recordedCallerIp(req),
            userAgent: req.headers.get("user-agent") ?? null,
          },
        }),
        prisma.documentAccessLog.create({
          data: {
            documentId: agreementDocument.id,
            accessorType: "staff",
            accessorId: guard.user.id,
            action: "email_in_signing_packet",
            ipAddress: recordedCallerIp(req),
            userAgent: req.headers.get("user-agent") ?? null,
          },
        }),
      ])
    }
    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: delivery.ok
        ? AuditAction.SIGNING_PACKET_EMAILED
        : AuditAction.SIGNING_PACKET_EMAIL_FAILED,
      entity: "LoanApplication",
      entityId: id,
      ipAddress: recordedCallerIp(req) ?? undefined,
      newValue: {
        pasqDocumentId: pasqDocument.id,
        pasqDocumentSha256: application.pasqDocumentSha256,
        agreementDocumentId: agreementDocument.id,
        agreementDocumentSha256: application.agreementDocumentSha256,
        sentTo: maskDestination(sentTo),
        providerOutcome: delivery.providerOutcome,
        possiblyDelivered,
      },
    })

    if (!delivery.ok) {
      return NextResponse.json(
        {
          error: possiblyDelivered
            ? "The email provider gave no delivery verdict. Check with the client before resending."
            : "The signing packet could not be delivered.",
        },
        { status: 502 },
      )
    }
    return NextResponse.json({
      success: true,
      sentTo: maskDestination(sentTo),
    })
  })
}

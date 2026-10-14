import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getDocumentCaller } from "@/lib/document-auth"
import { withTenantContextLoggingRefusal } from "@/lib/documents/tenant-refusal"
import { logAudit, AuditAction } from "@/lib/audit"
import { recordedCallerIp } from "@/lib/rate-limit"
import { checkSigningOtp, consumeSigningOtp, SigningOtpRefusedError } from "@/lib/signing-otp/challenge"
import { isSigningOtpRequired, signingOtpChallengeIdFrom, signingOtpRefusal } from "@/lib/signing-otp/policy"

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * Signs a `ClientDocument` — the native e-signature counterpart to
 * `app/api/applications/[id]/agreement/sign/route.ts`, generalised to any
 * document (not just the credit agreement). That route is deliberately left
 * untouched; this one mirrors its ownership + IP-capture pattern instead.
 *
 * Reachable by both staff and CLIENT sessions: `isSharedClientApiPath` in
 * proxy.ts already allowlists `/api/documents/*` (except `/extract`) for the
 * portal host, so — exactly like the agreement route's `isClientSession`
 * guard — a CLIENT caller's ownership of the target document is enforced
 * unconditionally, not gated on `method`. Staff sign on behalf of the client.
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  const caller = await getDocumentCaller()
  if (!caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params
  return withTenantContextLoggingRefusal(req, { documentId: id, caller }, async (tenant) => {
    const body = (await req.json()) as { method?: string }
    const method = body.method
    if (method !== "branch" && method !== "portal") {
      return NextResponse.json({ error: "method must be 'branch' or 'portal'" }, { status: 400 })
    }

    const doc = await prisma.clientDocument.findFirst({
      where: { id, tenantId: tenant.id },
    })
    if (!doc || doc.deletedAt) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 })
    }

    // A CLIENT session may only ever sign a document belonging to their OWN
    // client record — enforced unconditionally (NOT gated on `method`); see
    // the module doc comment above.
    if (caller.type === "client" && doc.clientId !== caller.clientId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    // Credit agreements carry application-level affordability, document-hash
    // and signature evidence. They must only be signed through the dedicated
    // route that verifies all three atomically.
    if (doc.docType === "CREDIT_AGREEMENT") {
      return NextResponse.json(
        {
          error: "Credit agreements must be signed through the application agreement workflow.",
          agreementIntegrity: "dedicated_signing_required",
        },
        { status: 409 },
      )
    }
    if (doc.docType === "DEBIT_MANDATE") {
      return NextResponse.json(
        {
          error: "Debit mandates must be signed through the application repayment-setup workflow.",
          debitMandate: "dedicated_signing_required",
        },
        { status: 409 },
      )
    }

    if (doc.signatureState === "signed") {
      return NextResponse.json({ error: "Document is already signed" }, { status: 409 })
    }

    // Signing OTP (lib/signing-otp/policy.ts). The session decides the method,
    // not the body: a CLIENT is portal signing (it cannot claim the branch
    // exemption), staff are a branch witness. The code is bound to the
    // document's content digest.
    const otpMethod = caller.type === "client" ? "portal" : "branch"
    const signingOtpNeeded = await isSigningOtpRequired(tenant.id, otpMethod)
    const signingOtpChallengeId = signingOtpChallengeIdFrom(body)
    const signingOtpBinding = {
      tenantId: tenant.id,
      clientId: doc.clientId,
      purpose: "DOCUMENT" as const,
      subjectId: id,
      documentSha256: doc.contentSha256 ?? "",
    }
    if (signingOtpNeeded) {
      if (!doc.contentSha256) {
        return NextResponse.json(
          { error: "This document has no integrity digest, so it cannot be signed with a code.", signingOtp: "no_digest" },
          { status: 422 },
        )
      }
      const refusal = await checkSigningOtp(prisma, signingOtpChallengeId, signingOtpBinding)
      if (refusal) return signingOtpRefusal(refusal)
    }

    const ip = recordedCallerIp(req)

    const signedAt = new Date()

    let signed
    try {
      signed = await prisma.$transaction(async (tx) => {
        const signingOtp = signingOtpNeeded
          ? await consumeSigningOtp(tx, {
              ...signingOtpBinding,
              challengeId: signingOtpChallengeId!,
              method: otpMethod,
              now: signedAt,
            })
          : null
        // Claimed only while still unsigned and still the bytes that were
        // checked: a concurrent signature or a replaced file misses, and the
        // transaction (code included) rolls back.
        const claimed = await tx.clientDocument.updateMany({
          where: {
            id,
            tenantId: tenant.id,
            deletedAt: null,
            contentSha256: doc.contentSha256,
            OR: [{ signatureState: null }, { signatureState: { not: "signed" } }],
          },
          data: {
            signatureState: "signed",
            signedAt,
            signedByIp: ip,
          },
        })
        if (claimed.count !== 1) throw new DocumentChangedWhileSigning()
        const row = await tx.clientDocument.findFirstOrThrow({ where: { id, tenantId: tenant.id } })
        return { row, signingOtp }
      })
    } catch (error) {
      if (error instanceof SigningOtpRefusedError) return signingOtpRefusal(error.reason)
      if (error instanceof DocumentChangedWhileSigning) {
        return NextResponse.json({ error: "The document was signed or changed while you were signing." }, { status: 409 })
      }
      throw error
    }
    const { row: updated, signingOtp } = signed

    await logAudit({
      tenantId: tenant.id,
      userId: caller.type === "staff" ? caller.userId : undefined,
      userEmail: caller.type === "client" ? caller.email : undefined,
      action: AuditAction.DOCUMENT_SIGNED,
      entity: "ClientDocument",
      entityId: id,
      newValue: { method, signedAt: signedAt.toISOString(), ...(signingOtp ? { signingOtp } : {}) },
      ipAddress: ip ?? undefined,
    })

    // POPIA access log (lib/document-auth.ts writes this pattern elsewhere).
    await prisma.documentAccessLog.create({
      data: {
        documentId: id,
        accessorType: caller.type,
        accessorId: caller.type === "staff" ? caller.userId : caller.clientId,
        action: "signed",
        ipAddress: ip,
      },
    })

    return NextResponse.json(updated)
  })
}

class DocumentChangedWhileSigning extends Error {}

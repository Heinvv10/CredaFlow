import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { auth } from "@/lib/auth"
import { withTenantContext } from "@/lib/tenant"
import { logAudit, AuditAction } from "@/lib/audit"
import { recordedCallerIp } from "@/lib/rate-limit"
import { clientViewableDisclosureDocumentId } from "@/lib/insurance/disclosure-access"

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * The policyholder acknowledging the PPR / product disclosure in their own
 * name. This is deliberately a CLIENT-authenticated route: the staff route
 * (app/api/insurance/policies/[id]/ppr) can record issuance, but an
 * acknowledgement stamped by staff on the client's behalf is not evidence
 * that the client acknowledged anything.
 *
 * pprAcknowledgedAt feeds the FSCA quarterly return, so this must never write
 * a timestamp that the client did not actually cause.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { id } = await params

  const session = await auth()
  const email = session?.user?.email
  if (!email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  return withTenantContext(req, async (tenant) => {
    const client = await prisma.client.findFirst({
      where: { email, tenantId: tenant.id },
      select: { id: true },
    })
    if (!client) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const policy = await prisma.insurancePolicy.findFirst({
      where: { id, clientId: client.id, tenantId: tenant.id },
      select: {
        id: true,
        pprIssuedAt: true,
        pprAcknowledgedAt: true,
        faisDisclosurePdfUrl: true,
      },
    })
    // Someone else's policy is indistinguishable from a non-existent one.
    if (!policy) {
      return NextResponse.json({ error: "Policy not found" }, { status: 404 })
    }

    // You cannot acknowledge a disclosure that was never issued to you —
    // doing so would fabricate a compliance record.
    if (!policy.pprIssuedAt) {
      return NextResponse.json(
        { error: "The product disclosure for this policy has not been issued yet." },
        { status: 409 },
      )
    }

    // The disclosure must be one this client can actually open. A STANDALONE
    // policy's url points at a staff-only, one-hour-TTL endpoint, so no client
    // can ever have read it — accepting an acknowledgement against that would
    // record exactly the unevidenced attestation this route exists to prevent.
    const documentId = clientViewableDisclosureDocumentId(policy.faisDisclosurePdfUrl)
    if (!documentId) {
      return NextResponse.json(
        { error: "This policy's product disclosure is not available online. Please contact us for a copy." },
        { status: 409 },
      )
    }

    // Server-side proof the client actually opened it. The browser checkbox is
    // an assertion by the user agent; this is evidence. /api/documents/[id]/view
    // writes a client-typed DocumentAccessLog row on every read, so a genuine
    // view leaves a record and a bare POST does not. Mirrors the PASQ gate in
    // lib/compliance/pasq-acknowledgement.server.ts.
    const priorView = await prisma.documentAccessLog.findFirst({
      where: {
        documentId,
        accessorType: "client",
        accessorId: client.id,
        action: "view",
        createdAt: { gte: policy.pprIssuedAt },
      },
      select: { id: true },
    })
    if (!priorView) {
      return NextResponse.json(
        { error: "Open and review the product disclosure before acknowledging it." },
        { status: 422 },
      )
    }

    if (policy.pprAcknowledgedAt) {
      return NextResponse.json({
        acknowledged: true,
        acknowledgedAt: policy.pprAcknowledgedAt.toISOString(),
        alreadyAcknowledged: true,
      })
    }

    const acknowledgedAt = new Date()

    // Compare-and-set on pprAcknowledgedAt: null. Two concurrent submits cannot
    // both win, so the acknowledgement timestamp can never be silently moved
    // once set — a plain update() would let the second request overwrite the
    // first and rewrite a regulatory record.
    const claimed = await prisma.insurancePolicy.updateMany({
      where: {
        id: policy.id,
        clientId: client.id,
        tenantId: tenant.id,
        pprAcknowledgedAt: null,
      },
      data: {
        pprAcknowledgedAt: acknowledgedAt,
        pprAcknowledgedBy: client.id,
      },
    })

    if (claimed.count !== 1) {
      // Lost the race; the winner's timestamp stands.
      const current = await prisma.insurancePolicy.findFirst({
        where: { id: policy.id, clientId: client.id, tenantId: tenant.id },
        select: { pprAcknowledgedAt: true },
      })
      return NextResponse.json({
        acknowledged: true,
        acknowledgedAt: current?.pprAcknowledgedAt?.toISOString() ?? null,
        alreadyAcknowledged: true,
      })
    }

    await logAudit({
      tenantId: tenant.id,
      userEmail: email,
      action: AuditAction.INSURANCE_PPR_ACKNOWLEDGED,
      entity: "InsurancePolicy",
      entityId: policy.id,
      ipAddress: recordedCallerIp(req) ?? undefined,
      oldValue: { pprAcknowledgedAt: null },
      newValue: {
        pprAcknowledgedAt: acknowledgedAt.toISOString(),
        pprAcknowledgedBy: client.id,
        channel: "CLIENT_PORTAL",
        // There is no column binding the acknowledgement to a document, so the
        // audit row is the only place the identity of the accepted disclosure
        // is recorded. Without it "acknowledged" names no particular document.
        disclosureDocumentId: documentId,
        priorViewLogId: priorView.id,
        userAgent: req.headers.get("user-agent") ?? null,
      },
    })

    return NextResponse.json({
      acknowledged: true,
      acknowledgedAt: acknowledgedAt.toISOString(),
    })
  })
}

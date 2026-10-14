import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { sendEmail } from "@/lib/email/service"
import { getTenantFromRequest } from "@/lib/tenant"
import { portalContinueUrl } from "@/lib/portal-urls"
import { lenderIdentityOrRefusal } from "@/lib/config/identity-response"
import {
  applicationSubmittedEmail,
  applicationApprovedEmail,
  applicationDeclinedEmail,
} from "@/lib/email/templates/portal"
import { EntityBorrowerError, hasClientBorrower } from "@/lib/borrower"

interface RequestBody {
  applicationId: string
  event: "submitted" | "approved" | "declined"
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization")
  const secret = process.env.INTERNAL_API_SECRET
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: RequestBody
  try {
    body = await req.json() as RequestBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const { applicationId, event } = body
  if (!applicationId || !event) {
    return NextResponse.json({ error: "Missing applicationId or event" }, { status: 400 })
  }

  const tenant = await getTenantFromRequest(req)
  if (!tenant) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 400 })
  }

  const application = await prisma.loanApplication.findUnique({
    where: { id: applicationId, tenantId: tenant.id },
    include: {
      client: { select: { firstName: true, lastName: true, email: true, portalPassword: true } },
      product: { select: { name: true } },
    },
  })

  if (!application) {
    return NextResponse.json({ error: "Application not found" }, { status: 404 })
  }
  // The application emails address a consumer; an entity borrower is refused.
  if (!hasClientBorrower(application)) {
    return NextResponse.json({ error: new EntityBorrowerError().message }, { status: 409 })
  }

  // Customer email names the lender: refuse when its identity is unconfigured.
  const lender = await lenderIdentityOrRefusal(tenant.id)
  if (lender.refusal) return lender.refusal
  const identity = lender.identity

  const clientName = `${application.client.firstName} ${application.client.lastName}`
  const clientEmail = application.client.email
  const productName = application.product.name
  const reference = application.reference
  const amount = application.approvedAmount ?? application.appliedAmount

  let subject: string
  let html: string

  if (event === "submitted") {
    subject = "We've received your loan application"
    // Click-time routing via /portal/continue (login if registered, else register).
    const portalCtaUrl = portalContinueUrl(clientEmail, reference)
    html = applicationSubmittedEmail(identity, clientName, reference, productName, application.appliedAmount, portalCtaUrl)
  } else if (event === "approved") {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? `https://${req.headers.get("host")}`
    const portalUrl = `${baseUrl}/portal/applications/${application.id}`
    subject = "Your loan application has been approved"
    html = applicationApprovedEmail(identity, clientName, reference, productName, amount, portalUrl)
  } else if (event === "declined") {
    subject = "Update on your loan application"
    html = applicationDeclinedEmail(identity, clientName, reference, application.decisionReason ?? "")
  } else {
    return NextResponse.json({ error: "Unknown event" }, { status: 400 })
  }

  const result = await sendEmail({
    tenantId: tenant.id,
    to: clientEmail,
    toName: clientName,
    subject,
    html,
    category: `application_${event}`,
    referenceId: applicationId,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "Failed to send email" }, { status: 500 })
  }

  return NextResponse.json({ ok: true, messageId: result.messageId })
}

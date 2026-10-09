import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { verifyUnsubToken, type UnsubPayload } from "@/lib/unsubscribe/token"
import { logAudit } from "@/lib/audit"
import { lockContactConsentSubject } from "@/lib/messaging/consent-lock"

type RevokeOutcome = { id: string }

async function executeRevoke(
  payload: UnsubPayload,
  tenantId: string,
  via: "GET" | "POST"
): Promise<RevokeOutcome> {
  const now = new Date()
  const result = await prisma.$transaction(async (tx) => {
    const txClient = tx as unknown as {
      $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>
      contactConsent: {
        updateMany: (args: {
          where: { contactId: string; channel: "EMAIL"; purpose: "MARKETING_GENERAL"; effectiveTo: null }
          data: { effectiveTo: Date }
        }) => Promise<{ count: number }>
        create: (args: {
          data: {
            tenantId: string
            contactId: string
            channel: "EMAIL"
            purpose: "MARKETING_GENERAL"
            status: "REVOKED"
            source: "EMAIL_LIST_UNSUBSCRIBE"
            effectiveFrom: Date
          }
        }) => Promise<{ id: string }>
      }
    }
    await lockContactConsentSubject(txClient, {
      tenantId,
      contactId: payload.contactId,
    })
    await txClient.contactConsent.updateMany({
      where: {
        contactId: payload.contactId,
        channel: "EMAIL",
        purpose: "MARKETING_GENERAL",
        effectiveTo: null,
      },
      data: { effectiveTo: now },
    })
    const created = await txClient.contactConsent.create({
      data: {
        tenantId,
        contactId: payload.contactId,
        channel: "EMAIL",
        purpose: "MARKETING_GENERAL",
        status: "REVOKED",
        source: "EMAIL_LIST_UNSUBSCRIBE",
        effectiveFrom: now,
      },
    })
    return { id: created.id }
  })

  await logAudit({
    tenantId,
    action: "CONSENT_REVOKED_VIA_UNSUBSCRIBE",
    entity: "ContactConsent",
    entityId: result.id,
    newValue: {
      channel: "EMAIL",
      purpose: "MARKETING_GENERAL",
      source: "EMAIL_LIST_UNSUBSCRIBE",
      contactId: payload.contactId,
      via,
    },
  })

  return result
}

async function resolveTenantId(): Promise<{ id: string } | { error: string; status: number }> {
  const slug = process.env.NEXT_PUBLIC_TENANT_SLUG
  if (!slug) return { error: "NEXT_PUBLIC_TENANT_SLUG not configured", status: 500 }
  const tenant = await prisma.tenant.findUnique({ where: { slug } })
  if (!tenant) return { error: "Tenant not found", status: 500 }
  return { id: tenant.id }
}

function landingHtml(success: boolean, message: string): string {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>${success ? "Unsubscribed" : "Unsubscribe error"}</title>
<body style="font-family: system-ui, sans-serif; max-width: 480px; margin: 4rem auto; padding: 1rem;">
<h1>${success ? "You're unsubscribed" : "Unsubscribe failed"}</h1>
<p>${message}</p>
${success ? '<p>You can manage all your preferences in the <a href="/portal/preferences">portal</a>.</p>' : ""}
</body></html>`
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.UNSUB_TOKEN_SECRET
  if (!secret) {
    return NextResponse.json({ error: "UNSUB_TOKEN_SECRET not configured" }, { status: 500 })
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    // Wrong content-type or unparseable body — RFC 8058 requires
    // application/x-www-form-urlencoded for the one-click POST. Anything
    // else is a client error, NOT a 500 (which some MUAs treat as
    // "retry later" and would just resurface the same bad request).
    return NextResponse.json({ error: "expected application/x-www-form-urlencoded" }, { status: 400 })
  }
  const tokenField = form.get("uns")
  if (typeof tokenField !== "string" || tokenField.length === 0) {
    return NextResponse.json({ error: "missing uns" }, { status: 400 })
  }

  const verify = verifyUnsubToken(tokenField, secret)
  if (!verify.ok) {
    return NextResponse.json({ error: verify.reason }, { status: 400 })
  }

  const tenant = await resolveTenantId()
  if ("error" in tenant) {
    return NextResponse.json({ error: tenant.error }, { status: tenant.status })
  }

  await runWithTenant(tenant.id, async () => {
    await executeRevoke(verify.payload, tenant.id, "POST")
  })

  // RFC 8058: a bare 200 OK is required. Body is permitted but ignored by
  // mail clients, so we return empty.
  return new NextResponse(null, { status: 200 })
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.UNSUB_TOKEN_SECRET
  if (!secret) {
    return new NextResponse(landingHtml(false, "Service misconfiguration. Please contact support."), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  }

  const token = req.nextUrl.searchParams.get("uns")
  if (!token) {
    return new NextResponse(landingHtml(false, "Missing unsubscribe token."), {
      status: 400,
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  }

  const verify = verifyUnsubToken(token, secret)
  if (!verify.ok) {
    return new NextResponse(landingHtml(false, "This unsubscribe link is no longer valid."), {
      status: 400,
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  }

  const tenant = await resolveTenantId()
  if ("error" in tenant) {
    return new NextResponse(landingHtml(false, "Service misconfiguration. Please contact support."), {
      status: tenant.status,
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  }

  await runWithTenant(tenant.id, async () => {
    await executeRevoke(verify.payload, tenant.id, "GET")
  })

  return new NextResponse(
    landingHtml(true, "Marketing emails will no longer be sent to this address."),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  )
}

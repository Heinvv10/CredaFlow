import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { auth } from "@/lib/auth"
import { withTenantContext } from "@/lib/tenant"
import { computeConsentTransition, type ConsentPurposes } from "@/lib/consent"
import { logAudit, AuditAction } from "@/lib/audit"

const ALLOWED_KEYS = ["smsMarketing", "emailMarketing"] as const

export async function PUT(req: Request) {
  const session = await auth()
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const desired: Partial<ConsentPurposes> = {}
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.includes(key as (typeof ALLOWED_KEYS)[number])) {
      return NextResponse.json(
        { error: "Only marketing preferences can be changed here." },
        { status: 400 },
      )
    }
    if (typeof body[key] !== "boolean") {
      return NextResponse.json(
        { error: `${key} must be a boolean.` },
        { status: 400 },
      )
    }
    desired[key as keyof ConsentPurposes] = body[key] as boolean
  }

  return withTenantContext(req, async (tenant) => {
    const client = await prisma.client.findFirst({
      where: { email: session.user.email!, tenantId: tenant.id },
      select: { id: true },
    })
    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 })
    }

    const { row, auditEvents } = await prisma.$transaction(async (tx) => {
      const existing = await tx.clientConsent.findUnique({
        where: { clientId: client.id },
      })
      const current = existing ?? {
        creditBureauEnquiry: false,
        insuranceUnderwriting: false,
        smsMarketing: false,
        emailMarketing: false,
        thirdPartySharing: false,
        automatedDecisionMaking: false,
        withdrawnAt: null,
      }

      const transition = computeConsentTransition(current, desired, {
        actorId: null, // self-service — no staff actor
      })

      if (transition.auditEvents.length === 0) {
        return { row: existing, auditEvents: [] as typeof transition.auditEvents }
      }

      // capturedBy intentionally omitted on portal create — this is self-service with no staff actor.
      const upserted = await tx.clientConsent.upsert({
        where: { clientId: client.id },
        create: {
          clientId: client.id,
          creditBureauEnquiry: false,
          insuranceUnderwriting: false,
          smsMarketing: false,
          emailMarketing: false,
          thirdPartySharing: false,
          automatedDecisionMaking: false,
          ...transition.updates,
        },
        update: transition.updates,
      })

      return { row: upserted, auditEvents: transition.auditEvents }
    })

    // Portal allowlist only permits sms/emailMarketing keys, so computeConsentTransition
    // cannot produce CONSENT_GRANTED / CONSENT_WITHDRAWN bulk events here — those require
    // all 4 processing purposes to change in one call. If ALLOWED_KEYS ever expands to
    // include processing purposes, this loop must grow an else-branch to audit them.
    if (row !== null) {
      for (const event of auditEvents) {
        if (event.action === AuditAction.CONSENT_PURPOSE_CHANGED) {
          await logAudit({
            tenantId: tenant.id,
            userEmail: session.user.email!,
            action: AuditAction.CONSENT_PURPOSE_CHANGED,
            entity: "ClientConsent",
            entityId: row.id,
            oldValue: { [event.purpose]: event.from },
            newValue: { [event.purpose]: event.to },
          })
        }
      }
    }

    return NextResponse.json({
      consent: row
        ? {
            smsMarketing: row.smsMarketing,
            emailMarketing: row.emailMarketing,
          }
        : null,
    })
  })
}

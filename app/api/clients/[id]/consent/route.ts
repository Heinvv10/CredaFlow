import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { getDefaultTenantId } from "@/lib/tenant"
import { computeConsentTransition, type ConsentPurposes, ALL_PURPOSES, PROCESSING_PURPOSES } from "@/lib/consent"
import { logAudit, AuditAction } from "@/lib/audit"

const MIN_REASON_LEN = 8

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if ("error" in guard) return guard.error
  const { user } = guard

  const { id } = await params

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const desired: Partial<ConsentPurposes> = {}
  const reasonRaw = typeof body.reason === "string" ? body.reason.trim() : undefined

  for (const key of Object.keys(body)) {
    if (key === "reason") continue
    if (!ALL_PURPOSES.includes(key as (typeof ALL_PURPOSES)[number])) {
      return NextResponse.json({ error: `Unknown key: ${key}` }, { status: 400 })
    }
    if (typeof body[key] !== "boolean") {
      return NextResponse.json(
        { error: `${key} must be a boolean.` },
        { status: 400 },
      )
    }
    desired[key as keyof ConsentPurposes] = body[key] as boolean
  }

  const tenantId = await getDefaultTenantId()

  const client = await prisma.client.findFirst({
    where: { id, tenantId },
    select: { id: true, tenantId: true },
  })
  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 })
  }

  // Two-baseline pattern: the pre-tx baseline is used for the reason-gate UX check
  // (cheap to fail early without entering the transaction). Inside the transaction we
  // re-read the row as `committedBaseline` to compute the diff against the actual
  // current state — this closes the race window between the gate and the upsert.
  // Reason gate: required when any processing purpose is changing.
  // Runs before the transaction so a missing reason never touches the DB.
  const existing = await prisma.clientConsent.findUnique({
    where: { clientId: client.id },
  })
  const baseline = existing ?? {
    creditBureauEnquiry: false,
    insuranceUnderwriting: false,
    smsMarketing: false,
    emailMarketing: false,
    thirdPartySharing: false,
    automatedDecisionMaking: false,
    withdrawnAt: null,
  }
  const processingChanging = PROCESSING_PURPOSES.some(
    (k) => desired[k] !== undefined && desired[k] !== baseline[k],
  )
  if (processingChanging) {
    if (!reasonRaw) {
      return NextResponse.json(
        { error: "Reason required for processing-purpose changes." },
        { status: 400 },
      )
    }
    if (reasonRaw.length < MIN_REASON_LEN) {
      return NextResponse.json(
        { error: `Reason must be at least ${MIN_REASON_LEN} characters.` },
        { status: 400 },
      )
    }
  }

  const { row, auditEvents, committedBaseline } = await prisma.$transaction(async (tx) => {
    const committed = await tx.clientConsent.findUnique({
      where: { clientId: client.id },
    })
    const committedBaselineLocal = committed ?? {
      creditBureauEnquiry: false,
      insuranceUnderwriting: false,
      smsMarketing: false,
      emailMarketing: false,
      thirdPartySharing: false,
      automatedDecisionMaking: false,
      withdrawnAt: null,
    }

    const transition = computeConsentTransition(committedBaselineLocal, desired, {
      actorId: user.id,
      reason: reasonRaw,
    })

    if (transition.auditEvents.length === 0) {
      return { row: committed, auditEvents: [] as typeof transition.auditEvents, committedBaseline: committedBaselineLocal }
    }

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
        capturedBy: user.id,
        ...transition.updates,
      },
      update: transition.updates,
    })

    return { row: upserted, auditEvents: transition.auditEvents, committedBaseline: committedBaselineLocal }
  })

  // logAudit runs OUTSIDE the transaction — it uses the module-level prisma
  // client, not tx, so running it inside would create phantom audit rows on
  // rollback.
  if (row !== null) {
    for (const event of auditEvents) {
      if (event.action === AuditAction.CONSENT_PURPOSE_CHANGED) {
        await logAudit({
          tenantId,
          userId: user.id,
          userEmail: user.email,
          action: AuditAction.CONSENT_PURPOSE_CHANGED,
          entity: "ClientConsent",
          entityId: row.id,
          oldValue: { [event.purpose]: event.from },
          newValue: { [event.purpose]: event.to, reason: reasonRaw },
        })
      } else {
        await logAudit({
          tenantId,
          userId: user.id,
          userEmail: user.email,
          action:
            event.action === AuditAction.CONSENT_GRANTED
              ? AuditAction.CONSENT_GRANTED
              : AuditAction.CONSENT_WITHDRAWN,
          entity: "ClientConsent",
          entityId: row.id,
          oldValue: Object.fromEntries(
            (event.purposes as (keyof ConsentPurposes)[]).map((p) => [p, committedBaseline[p]]),
          ),
          newValue: { purposes: event.purposes, reason: reasonRaw },
        })
      }
    }
  }

  return NextResponse.json({ consent: row })
}

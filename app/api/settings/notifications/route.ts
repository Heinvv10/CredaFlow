import { NextRequest, NextResponse } from "next/server"
import { Channel } from "@prisma/client"
import { requireApiRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { logAudit, AuditAction } from "@/lib/audit"
import { submitTemplateForApproval, wabaFieldsChanged } from "@/lib/whatsapp/template-submit"

const VALID_CHANNELS = new Set<string>(Object.values(Channel))

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const templates = await prisma.messageTemplate.findMany({
      where: { tenantId: tenant.id },
      orderBy: [{ event: "asc" }, { channel: "asc" }],
    })

    return NextResponse.json(templates)
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  const allowedRoles = ["SUPER_ADMIN", "ADMIN", "LOAN_ADMIN", "BRANCH_MANAGER"]
  if (!allowedRoles.includes(guard.user.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 })
  }

  return withTenantContext(req, async (tenant) => {
    const body = await req.json() as {
      event: string
      channel: string
      subject?: string
      body: string
      active?: boolean
    }

    if (!body.event || !body.channel || !body.body) {
      return NextResponse.json({ error: "event, channel, and body are required" }, { status: 400 })
    }
    if (!VALID_CHANNELS.has(body.channel)) {
      return NextResponse.json(
        { error: `channel must be one of: ${[...VALID_CHANNELS].join(", ")}` },
        { status: 400 }
      )
    }
    const channel = body.channel as Channel

    // No separate create/update branches here (this is a single upsert), so
    // capture the prior row ourselves for the WABA-field change guard below.
    const before = await prisma.messageTemplate.findUnique({
      where: { tenantId_event_channel: { tenantId: tenant.id, event: body.event, channel } },
    })

    // A `key`-bearing row is a SYSTEM template: a seeded per-tenant default (or a
    // tenant-created statutory row such as section129_email), resolved
    // at dispatch time by `key`, not by (event, channel). This endpoint never
    // writes `key`, so it cannot author a usable template — it can only
    // overwrite a system one. That includes `section129_email`, whose body is
    // NCA-mandated statutory text that CLAUDE.md requires legal sign-off to
    // change, and whose consumer resolves it by key with only an active/
    // statutoryOverride guard.
    //
    // Rewriting one is also self-defeating: the dispatcher renders these with a
    // fixed variable set (lib/notifications.ts passes `{ body }`), and
    // lib/messaging/render.ts THROWS on an unknown placeholder — so a body
    // written in this editor's own {{firstName}} vocabulary stops the
    // notification from sending at all.
    // `!= null`, not truthiness: a blank key is as unreachable as a null one,
    // but it is still a stored value this endpoint must not silently claim.
    // The sibling WABA route treats "" as a repairable state for the same
    // reason, so it is a shape that can exist.
    if (before && before.key != null) {
      // One of these rows is the Section 129 notice. A blocked attempt to
      // rewrite statutory text is itself the auditable event.
      await logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.NOTIFICATION_TEMPLATE_UPDATE_REFUSED,
        entity: "MessageTemplate",
        entityId: before.id,
        oldValue: { key: before.key },
        newValue: { attemptedBody: body.body, attemptedSubject: body.subject ?? null },
      })
      return NextResponse.json(
        {
          error:
            `${before.key || "this"} is a system template, sent by its key — it cannot be edited here. `
            + `NCA-mandated text also needs legal sign-off to change.`,
        },
        { status: 409 },
      )
    }

    const template = await prisma.messageTemplate.upsert({
      where: { tenantId_event_channel: { tenantId: tenant.id, event: body.event, channel } },
      create: {
        tenantId: tenant.id,
        event: body.event,
        channel,
        subject: body.subject ?? null,
        body: body.body,
        active: body.active ?? true,
      },
      update: {
        subject: body.subject ?? null,
        body: body.body,
        active: body.active ?? true,
      },
    })

    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: AuditAction.NOTIFICATION_TEMPLATE_UPDATED,
      entity: "MessageTemplate",
      entityId: template.id,
      oldValue: before ? { subject: before.subject, body: before.body, active: before.active } : null,
      newValue: { event: body.event, channel, subject: template.subject, body: template.body, active: template.active },
    })

    // Best-effort: a Meta/submit failure must never fail the local save.
    if (template.wabaTemplateName && wabaFieldsChanged(before, template)) {
      await submitTemplateForApproval(tenant.id, template.id).catch((err) => {
        console.error("[settings/notifications] WABA template submit failed:", err)
      })
    }

    return NextResponse.json(template)
  })
}

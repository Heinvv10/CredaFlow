import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { verifyWaba, writeWebhookSignatureFailure } from "@/lib/webhooks"
import { parseWabaPayload, parseWabaPhoneNumberId, parseWabaAccountId, parseWabaStatuses } from "@/lib/whatsapp/waba-payload"
import { applyWabaStatuses } from "@/lib/whatsapp/apply-statuses"
import { parseWabaTemplateStatuses, applyWabaTemplateStatuses } from "@/lib/whatsapp/template-status"
import { lookupContactByChannelValue, toWaJid } from "@/lib/contact/identity"
import { handleWaStopInbound, STOP_REGEX } from "@/lib/messaging/wa-stop"
import { routeInbound } from "@/lib/inbox/routing"
import { getCommsSettings } from "@/lib/inbox/settings"
import { logAudit } from "@/lib/audit"

const PROVIDER = "WA_CLOUD" as const

export async function GET(req: NextRequest): Promise<Response> {
  const params = new URL(req.url).searchParams
  const token = process.env.WHATSAPP_CLOUD_VERIFY_TOKEN
  if (
    params.get("hub.mode") === "subscribe" &&
    token &&
    params.get("hub.verify_token") === token
  ) {
    return new Response(params.get("hub.challenge") ?? "", { status: 200 })
  }
  return new Response("Forbidden", { status: 403 })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.WHATSAPP_CLOUD_APP_SECRET
  if (!secret) {
    return NextResponse.json({ error: "WHATSAPP_CLOUD_APP_SECRET not configured" }, { status: 500 })
  }
  const rawBody = await req.text()

  let routedTenant: { id: string } | null = null
  try {
    const body = JSON.parse(rawBody)
    const phoneNumberId = parseWabaPhoneNumberId(body)
    if (phoneNumberId) {
      const owner = await prisma.commsSettings.findUnique({
        where: { wabaPhoneNumberId: phoneNumberId },
        select: { tenantId: true },
      })
      if (owner) routedTenant = { id: owner.tenantId }
    }
    if (!routedTenant) {
      // WABA-level events (message_template_status_update) carry no
      // phone_number_id, so they cannot be routed by number. Without this they
      // fall through to NEXT_PUBLIC_TENANT_SLUG, which would attribute another
      // tenant's template approval to whichever tenant that env var names.
      // wabaId is not unique in the schema, so findFirst.
      const wabaId = parseWabaAccountId(body)
      if (wabaId) {
        const owner = await prisma.commsSettings.findFirst({
          where: { wabaId },
          select: { tenantId: true },
        })
        if (owner) routedTenant = { id: owner.tenantId }
      }
    }
  } catch {
    // fall through to the slug fallback below (JSON parse handled again later)
  }
  const slug = process.env.NEXT_PUBLIC_TENANT_SLUG
  const tenant =
    routedTenant ??
    (slug ? await prisma.tenant.findUnique({ where: { slug } }) : null)
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 500 })

  const verify = verifyWaba({ rawBody, headers: req.headers, secret })
  if (!verify.ok) {
    const sourceIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
    const rawHeaders: Record<string, string> = {}
    req.headers.forEach((v, k) => { rawHeaders[k] = v })
    await writeWebhookSignatureFailure({
      provider: "META_WA",
      reason: verify.reason,
      pathname: "/api/webhooks/whatsapp-cloud",
      rawBody, rawHeaders, sourceIp, tenantId: tenant.id,
    })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  // Delivery/read receipts (handled in Task 5) — ack fast, never 500.
  // Falls through rather than returning, for the batching reason given at the
  // template branch below: one POST can carry receipts AND an inbound message,
  // and a 200 that skipped the message is a message Meta will never resend.
  const statuses = parseWabaStatuses(payload)
  if (statuses.length > 0) {
    await runWithTenant(tenant.id, () => applyWabaStatuses(tenant.id, statuses))
  }

  // Template approval transitions. Counterpart to /api/cron/poll-wa-templates,
  // not a duplicate: the poll re-checks PENDING rows only, so it cannot see a
  // later APPROVED -> PAUSED / DISABLED — a paused template would keep reading
  // APPROVED here and every send would fail at Meta with no local signal.
  // These arrive on the same subscription as `messages` and were previously
  // dropped by the fall-through below.
  //
  // Deliberately does NOT return: `entry[]` and `changes[]` are arrays and Meta
  // batches, so one POST can carry a template transition AND an inbound
  // message. Returning here would ack 200 and silently discard the message —
  // and Meta does not retry a 200. Both parsers above scan every entry, which
  // is only necessary because batching is real; an early return contradicts
  // that.
  const templateStatuses = parseWabaTemplateStatuses(payload)
  let templatesWritten = 0
  if (templateStatuses.length > 0) {
    templatesWritten = await applyWabaTemplateStatuses(tenant.id, templateStatuses)
    // This write decides whether a template — including the NCA arrears and
    // s.129 courtesy sends — may go out beyond the 24h service window. When
    // someone asks why WhatsApp notices stopped on a given day, "Meta paused
    // the template" has to be answerable from the audit log. The route already
    // audits MESSAGE_RECEIVED and CONSENT_REVOKED_VIA_STOP_KEYWORD below.
    await logAudit({
      tenantId: tenant.id,
      action: "WA_TEMPLATE_STATUS_CHANGED",
      entity: "MessageTemplate",
      entityId: templateStatuses.map((t) => t.name).join(","),
      newValue: { transitions: templateStatuses, rowsWritten: templatesWritten },
    })
  }

  const parsed = parseWabaPayload(payload)
  if (!parsed) {
    return NextResponse.json(
      { ok: true, persisted: false, statuses: statuses.length, templateStatuses: templateStatuses.length, templatesWritten },
      { status: 200 },
    )
  }

  const fromValue = toWaJid(parsed.fromPhone)
  if (!fromValue) return NextResponse.json({ error: "Unrecognised from-phone" }, { status: 400 })

  return runWithTenant(tenant.id, async () => {
    const contact = await lookupContactByChannelValue(prisma, {
      tenantId: tenant.id, channel: "WHATSAPP", value: fromValue,
    })
    const now = new Date()
    const settings = await getCommsSettings(tenant.id)
    const isStop = STOP_REGEX.test(parsed.text.trimStart())

    try {
      const result = await prisma.$transaction(async (tx) => {
        if (isStop && contact) {
          const stop = await handleWaStopInbound(tx as Parameters<typeof handleWaStopInbound>[0], {
            tenantId: tenant.id, contact: { id: contact.id, tenantId: contact.tenantId },
            fromValue, text: parsed.text, providerMessageId: parsed.providerMessageId,
            provider: PROVIDER, now,
          })
          return { messageId: stop.messageId, conversationId: stop.conversationId, contactId: contact.id, consentRevokedId: stop.consentRevokedId, persisted: true, handled: true }
        }
        if (!contact) {
          const routed = await routeInbound(tx as unknown as Prisma.TransactionClient, {
            tenantId: tenant.id, fromValue, fromPhone: parsed.fromPhone, text: parsed.text,
            providerMessageId: parsed.providerMessageId, waEnabled: settings?.whatsappEnabled ?? false, isStop,
            provider: PROVIDER, now,
          })
          return routed.handled
            ? { messageId: routed.messageId, conversationId: routed.conversationId, contactId: routed.contactId, persisted: true, handled: true }
            : { persisted: false, handled: false }
        }
        const stop = await handleWaStopInbound(tx as Parameters<typeof handleWaStopInbound>[0], {
          tenantId: tenant.id, contact: { id: contact.id, tenantId: contact.tenantId },
          fromValue, text: parsed.text, providerMessageId: parsed.providerMessageId,
          provider: PROVIDER, now,
        })
        return { messageId: stop.messageId, conversationId: stop.conversationId, contactId: contact.id, consentRevokedId: stop.consentRevokedId, persisted: true, handled: true }
      })

      if (!result.persisted) return NextResponse.json({ ok: true, persisted: false }, { status: 200 })

      // POPIA consent trail. This route computed consentRevokedId and never
      // read it, so an opt-out on the LIVE provider left a REVOKED
      // ContactConsent row with no audit entry. Mirrors the bridge route.
      if ("consentRevokedId" in result && result.consentRevokedId) {
        await logAudit({
          tenantId: tenant.id,
          action: "CONSENT_REVOKED_VIA_STOP_KEYWORD",
          entity: "ContactConsent",
          entityId: result.consentRevokedId,
          newValue: {
            channel: "WHATSAPP",
            purpose: "SERVICE_COMMS",
            source: "WA_REPLY_KEYWORD",
            reason: "STOP",
            contactId: result.contactId ?? contact?.id,
            fromValue,
          },
        })
      }

      await logAudit({
        tenantId: tenant.id, action: "MESSAGE_RECEIVED", entity: "Message", entityId: result.messageId,
        newValue: { channel: "WHATSAPP", direction: "INBOUND", provider: PROVIDER, providerMessageId: parsed.providerMessageId, fromValue, contactId: result.contactId },
      })
      return NextResponse.json({ ok: true, persisted: true, messageId: result.messageId }, { status: 200 })
    } catch (err) {
      const target =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && Array.isArray(err.meta?.target)
          ? (err.meta.target as string[]) : null
      if (target?.includes("providerMessageId")) {
        return NextResponse.json({ ok: true, persisted: false, duplicate: true }, { status: 200 })
      }
      throw err
    }
  })
}

import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { verifyWaUnofficial, writeWebhookSignatureFailure } from "@/lib/webhooks"
import { lookupContactByChannelValue, toWaJid } from "@/lib/contact/identity"
import { handleWaStopInbound, STOP_REGEX } from "@/lib/messaging/wa-stop"
import { routeInbound } from "@/lib/inbox/routing"
import { getCommsSettings } from "@/lib/inbox/settings"
import { logAudit } from "@/lib/audit"
import { parseWabaPayload, type ParsedMessage } from "@/lib/whatsapp/waba-payload"

/** This route IS the Baileys bridge, so every message it persists is
 *  WA_UNOFFICIAL. Named for symmetry with the cloud route's PROVIDER. */
const PROVIDER = "WA_UNOFFICIAL" as const

type WebhookPersistResult = {
  handled: boolean
  persisted: boolean
  messageId?: string
  consentRevokedId?: string | null
  conversationId?: string
  contactId?: string
  outboundMessageIds: string[]
  replies: string[]
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.WA_UNOFFICIAL_WEBHOOK_SECRET
  if (!secret) {
    return NextResponse.json({ error: "WA_UNOFFICIAL_WEBHOOK_SECRET not configured" }, { status: 500 })
  }
  const slug = process.env.NEXT_PUBLIC_TENANT_SLUG
  if (!slug) {
    return NextResponse.json({ error: "NEXT_PUBLIC_TENANT_SLUG not configured" }, { status: 500 })
  }

  const rawBody = await req.text()
  const tenant = await prisma.tenant.findUnique({ where: { slug } })
  if (!tenant) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 500 })
  }

  const verify = verifyWaUnofficial({ rawBody, headers: req.headers, secret })
  if (!verify.ok) {
    const sourceIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
    const rawHeaders: Record<string, string> = {}
    req.headers.forEach((v, k) => { rawHeaders[k] = v })
    await writeWebhookSignatureFailure({
      provider: "WA_UNOFFICIAL",
      reason: verify.reason,
      pathname: "/api/webhooks/whatsapp",
      rawBody,
      rawHeaders,
      sourceIp,
      tenantId: tenant.id,
    })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let parsed: ParsedMessage | null
  try {
    parsed = parseWabaPayload(JSON.parse(rawBody))
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  if (!parsed) {
    return NextResponse.json({ error: "Unrecognised WABA payload" }, { status: 400 })
  }

  const fromValue = toWaJid(parsed.fromPhone)
  if (!fromValue) {
    return NextResponse.json({ error: "Unrecognised from-phone" }, { status: 400 })
  }

  return runWithTenant(tenant.id, async () => {
    const contact = await lookupContactByChannelValue(prisma, {
      tenantId: tenant.id,
      channel: "WHATSAPP",
      value: fromValue,
    })
    const now = new Date()
    const settings = await getCommsSettings(tenant.id)

    const isStop = STOP_REGEX.test(parsed.text.trimStart())

    let result: WebhookPersistResult
    try {
      result = await prisma.$transaction(async (tx): Promise<WebhookPersistResult> => {
        // Compliance-critical (POPIA/NCA): a STOP opt-out must revoke ContactConsent
        // and emit the audit. Route to the global STOP handler first (no bot reply).
        if (isStop && contact) {
          const stop = await handleWaStopInbound(tx as Parameters<typeof handleWaStopInbound>[0], {
            tenantId: tenant.id,
            contact: { id: contact.id, tenantId: contact.tenantId },
            fromValue,
            text: parsed.text,
            providerMessageId: parsed.providerMessageId,
            provider: PROVIDER,
            now,
          })
          return {
            handled: true,
            persisted: true,
            messageId: stop.messageId,
            consentRevokedId: stop.consentRevokedId,
            conversationId: stop.conversationId,
            contactId: contact.id,
            outboundMessageIds: [],
            replies: [],
          }
        }

        if (!contact) {
          // First-time (unknown) sender → provision + open a human inbox thread.
          // Known contacts fall through to handleWaStopInbound below, which
          // already persists their inbound message into a Conversation.
          const routed = await routeInbound(tx as unknown as Prisma.TransactionClient, {
            tenantId: tenant.id,
            fromValue,
            fromPhone: parsed.fromPhone,
            text: parsed.text,
            providerMessageId: parsed.providerMessageId,
            waEnabled: settings?.whatsappEnabled ?? false,
            isStop,
            provider: PROVIDER,
            now,
          })
          if (routed.handled) {
            return {
              handled: true,
              persisted: true,
              messageId: routed.messageId,
              conversationId: routed.conversationId,
              contactId: routed.contactId,
              outboundMessageIds: [],
              replies: [],
            }
          }
          return { handled: false, persisted: false, outboundMessageIds: [], replies: [] }
        }

        const stop = await handleWaStopInbound(tx as Parameters<typeof handleWaStopInbound>[0], {
          tenantId: tenant.id,
          contact: { id: contact.id, tenantId: contact.tenantId },
          fromValue,
          text: parsed.text,
          providerMessageId: parsed.providerMessageId,
          provider: PROVIDER,
          now,
        })
        return {
          handled: true,
          persisted: true,
          messageId: stop.messageId,
          consentRevokedId: stop.consentRevokedId,
          conversationId: stop.conversationId,
          outboundMessageIds: [],
          replies: [],
        }
      })
    } catch (err) {
      // WhatsApp delivery is at-least-once: a redelivered wamid re-hits the
      // Message @@unique([provider, providerMessageId]) constraint inside the
      // transaction above, which rolls back (no duplicate replies/events were
      // committed). Ack with 200 so the BSP stops retrying instead of piling
      // 500s onto an already-delivered message.
      const target =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && Array.isArray(err.meta?.target)
          ? (err.meta.target as string[])
          : null
      if (target?.includes("providerMessageId")) {
        return NextResponse.json({ ok: true, persisted: false, duplicate: true }, { status: 200 })
      }
      throw err
    }

    if (!result.handled && !result.persisted) {
      // Unknown senders → 200 OK with no DB writes.
      // Contact-creation-on-miss is owned by the inbound-matcher path.
      return NextResponse.json({ ok: true, persisted: false }, { status: 200 })
    }

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
      tenantId: tenant.id,
      action: "MESSAGE_RECEIVED",
      entity: "Message",
      entityId: result.messageId,
      newValue: {
        channel: "WHATSAPP",
        direction: "INBOUND",
        provider: PROVIDER,
        providerMessageId: parsed.providerMessageId,
        fromValue,
        contactId: result.contactId ?? contact?.id,
      },
    })

    return NextResponse.json({
      ok: true,
      persisted: true,
      messageId: result.messageId,
    }, { status: 200 })
  })
}

/**
 * Default message templates that carry a one-time code: the borrower signing
 * OTP (lib/signing-otp) and the WhatsApp leg of portal activation / password
 * reset. Part of DEFAULT_MESSAGE_TEMPLATES (seeded per tenant); a tenant
 * seeded before they existed gets the row on first use
 * (ensureDefaultMessageTemplate).
 *
 * Every body is redactStoredBody: the comms timeline records that a code was
 * sent, never the code. Every body also carries {{requestRef}}, a random value
 * that is never stored, so the Message row's fingerprint of the true body
 * cannot be searched for the 6-digit code.
 *
 * The WhatsApp rows have no wabaTemplateName: they send as free text, which
 * Meta allows only inside the 24h customer-service window. A code to a
 * borrower outside it fails as WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE and the
 * borrower is offered email. Sending outside the window needs a Meta
 * AUTHENTICATION-category template, which is not built.
 */
import type { MessageTemplate } from "@prisma/client"
import type { prisma as PrismaClientInstance } from "@/lib/prisma"
import { withSeededBrand } from "@/lib/whatsapp/template-vars"
import type { DefaultMessageTemplate } from "./default-templates"

export const SIGNING_OTP_TEMPLATE_KEYS = {
  EMAIL: "signing_otp_email",
  WHATSAPP: "signing_otp_whatsapp",
} as const

export const PORTAL_OTP_WHATSAPP_TEMPLATE_KEY = "portal_otp_whatsapp"

export const OTP_MESSAGE_TEMPLATES: readonly DefaultMessageTemplate[] = [
  {
    key: SIGNING_OTP_TEMPLATE_KEYS.EMAIL, event: "signing_otp", channel: "EMAIL", category: "TRANSACTIONAL",
    subject: "Your {{lenderName}} signing code",
    body: "Your {{lenderName}} code to sign your {{documentLabel}} is {{otp}}. It expires in 5 minutes. Never share this code with anyone, including our staff. Request reference {{requestRef}}.",
    bodyTemplate: "<p>Hi {{firstName}},</p>\n<p>Your code to sign your {{documentLabel}} with {{lenderName}} is:</p>\n<p style=\"font-size:28px;font-weight:bold;letter-spacing:6px;\">{{otp}}</p>\n<p>It expires in 5 minutes. Never share this code with anyone, including our staff. If you did not ask to sign anything, ignore this email.</p>\n<p>Request reference {{requestRef}}</p>",
    redactStoredBody: true,
  },
  {
    key: SIGNING_OTP_TEMPLATE_KEYS.WHATSAPP, event: "signing_otp", channel: "WHATSAPP", category: "TRANSACTIONAL",
    body: "{{lenderName}}: your code to sign your {{documentLabel}} is {{otp}}. It expires in 5 minutes. Never share this code with anyone, including our staff. Ref {{requestRef}}.",
    redactStoredBody: true,
  },
  {
    key: PORTAL_OTP_WHATSAPP_TEMPLATE_KEY, event: "portal_otp", channel: "WHATSAPP", category: "TRANSACTIONAL",
    body: "{{lenderName}}: your portal {{purposeLabel}} code is {{otp}}. It expires in 15 minutes. Never share this code with anyone. Ref {{requestRef}}.",
    redactStoredBody: true,
  },
]

type TemplateDb = Pick<typeof PrismaClientInstance, "messageTemplate" | "tenant">

/**
 * The tenant's active row for one of the templates above, created from the
 * default when the tenant has neither that key nor that (event, channel) —
 * the same skip rule as seedDefaultMessageTemplates. An operator's existing
 * row, active or not, is never touched: a deactivated one stays off and the
 * caller reports the channel unavailable.
 */
export async function ensureOtpMessageTemplate(
  db: TemplateDb,
  tenantId: string,
  key: string,
): Promise<MessageTemplate | null> {
  const def = OTP_MESSAGE_TEMPLATES.find((t) => t.key === key)
  if (!def) throw new Error(`Unknown OTP template key: ${key}`)
  const existing = await db.messageTemplate.findFirst({
    where: { tenantId, OR: [{ key }, { event: def.event, channel: def.channel }] },
  })
  if (existing) return existing.active && existing.key === key ? existing : null
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, config: { select: { brandName: true } } },
  })
  const brand = (tenant?.config?.brandName ?? tenant?.name ?? "").trim()
  if (!brand) return null
  const seeded = (v: string | undefined) => (v === undefined ? undefined : withSeededBrand(v, brand))
  try {
    return await db.messageTemplate.create({
      data: {
        tenantId, ...def,
        subject: seeded(def.subject), body: seeded(def.body)!, bodyTemplate: seeded(def.bodyTemplate),
      },
    })
  } catch (err) {
    // A concurrent first use created it: read the winner.
    if ((err as { code?: string }).code !== "P2002") throw err
    return db.messageTemplate.findFirst({ where: { tenantId, key, active: true } })
  }
}

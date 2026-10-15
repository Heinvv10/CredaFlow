/**
 * Delivery of a one-time code through the one send pipeline (sendMessage via
 * deliverViaMessaging), so each code send is a Message on the client's comms
 * timeline with its body redacted.
 *
 * Channels: EMAIL, and WHATSAPP only when the lender runs WhatsApp Cloud
 * (whatsappEnabled, provider WA_CLOUD, send credentials present). SMS is off
 * by policy (lib/messaging/.claude.md) and is never offered; the database
 * refuses an SMS signing challenge as well.
 */
import { prisma } from "@/lib/prisma"
import { normaliseEmail, toWaJid } from "@/lib/contact/identity"
import { deliverViaMessaging, resolveMessagingTarget } from "@/lib/messaging/route-delivery"
import { ensureOtpMessageTemplate } from "@/lib/messaging/otp-templates"
import { maskEmail, maskPhone } from "./code"

export type OtpChannel = "EMAIL" | "WHATSAPP"
export const OTP_CHANNELS: readonly OtpChannel[] = ["EMAIL", "WHATSAPP"]

export type OtpRecipient = { firstName: string; lastName: string; email: string | null; whatsapp: string | null }

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function isWhatsAppCloudConfigured(tenantId: string): Promise<boolean> {
  const settings = await prisma.commsSettings.findUnique({
    where: { tenantId },
    select: { whatsappEnabled: true, waProvider: true, wabaPhoneNumberId: true, wabaAccessToken: true },
  })
  return !!settings
    && settings.whatsappEnabled
    && settings.waProvider === "WA_CLOUD"
    && !!settings.wabaPhoneNumberId?.trim()
    && !!settings.wabaAccessToken?.trim()
}

/** The normalised address a code goes to on a channel, or "" when there is none. */
export function otpDestination(channel: OtpChannel, recipient: OtpRecipient): string {
  if (channel === "EMAIL") {
    const email = recipient.email ? normaliseEmail(recipient.email) : ""
    return EMAIL_SHAPE.test(email) ? email : ""
  }
  return recipient.whatsapp ? toWaJid(recipient.whatsapp) : ""
}

export function maskDestination(channel: OtpChannel, destination: string): string {
  return channel === "EMAIL" ? maskEmail(destination) : maskPhone(destination)
}

/** The channels this recipient can receive a code on from this lender. */
export async function availableOtpChannels(tenantId: string, recipient: OtpRecipient): Promise<OtpChannel[]> {
  const channels: OtpChannel[] = []
  if (otpDestination("EMAIL", recipient)) channels.push("EMAIL")
  if (otpDestination("WHATSAPP", recipient) && (await isWhatsAppCloudConfigured(tenantId))) channels.push("WHATSAPP")
  return channels
}

export type OtpDeliveryResult = {
  status: "ACCEPTED" | "SIMULATED" | "FAILED"
  error?: string
}

export async function deliverOtp(args: {
  tenantId: string
  channel: OtpChannel
  destination: string
  recipient: OtpRecipient
  templateKey: string
  vars: Record<string, string>
  idempotencyKey: string
}): Promise<OtpDeliveryResult> {
  const template = await ensureOtpMessageTemplate(prisma, args.tenantId, args.templateKey)
  if (!template) {
    return { status: "FAILED", error: `the ${args.templateKey} message template is inactive or cannot be created` }
  }
  const target = await resolveMessagingTarget({
    tenantId: args.tenantId,
    channel: args.channel,
    value: args.destination,
    templateKey: template.key ?? args.templateKey,
  })
  if (!target.ok) return { status: "FAILED", error: target.reason }
  const outcome = await deliverViaMessaging({
    contactId: target.contact.id,
    channel: args.channel,
    template: target.template,
    vars: args.vars,
    toValue: args.destination,
    toName: `${args.recipient.firstName} ${args.recipient.lastName}`.trim(),
    category: "signing-otp",
    idempotencyKey: args.idempotencyKey,
    // A code is only good for minutes: a retry sweep later would deliver a
    // dead code. The caller reports the failure and the borrower asks again.
    automaticRetry: false,
  })
  if (!outcome.ok) return { status: "FAILED", error: outcome.error ?? "delivery failed" }
  return { status: outcome.simulated ? "SIMULATED" : "ACCEPTED" }
}

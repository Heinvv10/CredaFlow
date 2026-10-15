/**
 * The WhatsApp leg of portal activation and password reset. The code row is
 * the same ClientOtp the email leg writes (keyed by the account's email, which
 * is what the borrower types back); only the delivery differs.
 *
 * Offered only when the lender runs WhatsApp Cloud (isWhatsAppCloudConfigured)
 * and the client has a WhatsApp number on file. SMS is never a fallback (off
 * by policy). A failed send is audited, never surfaced: the routes answer
 * identically whether or not an account matched.
 */
import { AuditAction, logAudit } from "@/lib/audit"
import { PORTAL_OTP_WHATSAPP_TEMPLATE_KEY } from "@/lib/messaging/otp-templates"
import { deliverOtp, otpDestination } from "@/lib/signing-otp/deliver"
import { otpRequestReference } from "@/lib/signing-otp/code"

export type PortalOtpChannel = "EMAIL" | "WHATSAPP"

export function portalOtpChannelFrom(value: unknown): PortalOtpChannel {
  return value === "WHATSAPP" ? "WHATSAPP" : "EMAIL"
}

type PortalOtpClient = { id: string; firstName: string; lastName: string; email: string | null; whatsapp: string | null }

/** True when this client can be sent a code on WhatsApp (pure: no I/O). */
export function clientReachableOnWhatsApp(client: Pick<PortalOtpClient, "firstName" | "lastName" | "email" | "whatsapp">): boolean {
  return otpDestination("WHATSAPP", client) !== ""
}

export async function sendPortalOtpByWhatsApp(args: {
  tenantId: string
  client: PortalOtpClient
  code: string
  purpose: "activation" | "password_reset"
  otpRecordId: string
}): Promise<void> {
  const { tenantId, client } = args
  const delivery = await deliverOtp({
    tenantId,
    channel: "WHATSAPP",
    destination: otpDestination("WHATSAPP", client),
    recipient: client,
    templateKey: PORTAL_OTP_WHATSAPP_TEMPLATE_KEY,
    vars: {
      otp: args.code,
      purposeLabel: args.purpose === "activation" ? "activation" : "password reset",
      requestRef: otpRequestReference(),
    },
    idempotencyKey: `portal-${args.purpose}:${args.otpRecordId}:WHATSAPP`,
  })
  if (delivery.status === "FAILED") {
    await logAudit({
      tenantId,
      action: AuditAction.MESSAGE_SEND_FAILED_UNDELIVERED,
      entity: "Client",
      entityId: client.id,
      newValue: {
        templateKey: PORTAL_OTP_WHATSAPP_TEMPLATE_KEY,
        channel: "WHATSAPP",
        purpose: args.purpose,
        failure: delivery.error ?? "delivery failed",
        consumerToldNothing: true,
      },
    })
  }
}

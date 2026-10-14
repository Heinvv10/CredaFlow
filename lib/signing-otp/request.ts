/**
 * Issue a signing OTP for a resolved subject (lib/signing-otp/subject.ts):
 * rate-limit, mint, deliver, then record the challenge whole.
 *
 * The row is written after the send so its delivery evidence (status, sentAt)
 * is a fact rather than a forecast, and so the database can freeze it
 * (guardSigningOtpChallenge). The id is minted first because the code hash and
 * the message's idempotency key both bind to it.
 */
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAudit } from "@/lib/audit"
import { demoCodeReveal } from "@/lib/config/demo-mode"
import { generateOtp } from "@/lib/otp"
import { SIGNING_OTP_TEMPLATE_KEYS } from "@/lib/messaging/otp-templates"
import {
  SIGNING_OTP_MAX_ATTEMPTS,
  SIGNING_OTP_REQUEST_LIMIT,
  SIGNING_OTP_TTL_MS,
  hashSigningOtp,
  otpRequestReference,
} from "./code"
import { deliverOtp, isWhatsAppCloudConfigured, maskDestination, otpDestination, type OtpChannel } from "./deliver"
import { DOCUMENT_LABELS, type SigningSubject } from "./subject"

export type IssuedChallenge = {
  challengeId: string
  channel: OtpChannel
  maskedDestination: string
  expiresAt: string
  demoCode?: string
}

export type RequestResult =
  | { ok: true; challenge: IssuedChallenge }
  | { ok: false; status: number; error: string; retryAfterSeconds?: number }

const CHANNEL_LABEL: Record<OtpChannel, string> = { EMAIL: "email", WHATSAPP: "WhatsApp" }

export async function requestSigningOtp(args: {
  subject: SigningSubject
  channel: OtpChannel
  method: "portal" | "branch"
  ip: string | null
  actor: { userId?: string; email?: string }
  now?: Date
}): Promise<RequestResult> {
  const { subject, channel } = args
  const now = args.now ?? new Date()
  const destination = otpDestination(channel, subject.recipient)
  if (!destination) {
    return { ok: false, status: 422, error: `There is no ${CHANNEL_LABEL[channel]} contact on file to send a code to.` }
  }
  if (channel === "WHATSAPP" && !(await isWhatsAppCloudConfigured(subject.tenantId))) {
    return { ok: false, status: 422, error: "WhatsApp codes are not available for this lender." }
  }

  // Counted in the database, not in process memory, so a restart or a second
  // replica does not reset the budget.
  const recent = await prisma.signingOtpChallenge.count({
    where: {
      tenantId: subject.tenantId,
      clientId: subject.clientId,
      purpose: subject.purpose,
      subjectId: subject.subjectId,
      createdAt: { gte: new Date(now.getTime() - SIGNING_OTP_REQUEST_LIMIT.windowMs) },
    },
  })
  if (recent >= SIGNING_OTP_REQUEST_LIMIT.limit) {
    return {
      ok: false,
      status: 429,
      error: "Too many codes requested. Wait a few minutes and try again.",
      retryAfterSeconds: SIGNING_OTP_REQUEST_LIMIT.windowMs / 1000,
    }
  }

  const challengeId = randomUUID()
  const code = generateOtp()
  const delivery = await deliverOtp({
    tenantId: subject.tenantId,
    channel,
    destination,
    recipient: subject.recipient,
    templateKey: SIGNING_OTP_TEMPLATE_KEYS[channel],
    vars: {
      firstName: subject.recipient.firstName,
      otp: code,
      documentLabel: DOCUMENT_LABELS[subject.purpose],
      requestRef: otpRequestReference(),
    },
    idempotencyKey: `signing-otp:${challengeId}:${channel}`,
  })

  // A demo borrower's .invalid mailbox never receives mail; there the screen
  // is the channel (lib/config/demo-mode.ts), recorded as SIMULATED.
  const reveal = channel === "EMAIL" ? demoCodeReveal(code, destination) : {}
  const deliveryStatus = delivery.status === "FAILED" && reveal.demoCode ? "SIMULATED" : delivery.status
  const maskedDestination = maskDestination(channel, destination)
  const expiresAt = new Date(now.getTime() + SIGNING_OTP_TTL_MS)

  await prisma.signingOtpChallenge.create({
    data: {
      id: challengeId,
      tenantId: subject.tenantId,
      clientId: subject.clientId,
      purpose: subject.purpose,
      subjectId: subject.subjectId,
      documentSha256: subject.documentSha256,
      codeHash: hashSigningOtp(challengeId, code),
      channel,
      maskedDestination,
      deliveryStatus,
      sentAt: deliveryStatus === "FAILED" ? null : now,
      expiresAt,
      maxAttempts: SIGNING_OTP_MAX_ATTEMPTS,
      requestedByUserId: args.method === "branch" ? args.actor.userId ?? null : null,
      requestedIp: args.ip,
      createdAt: now,
    },
  })
  await logAudit({
    tenantId: subject.tenantId,
    userId: args.actor.userId,
    userEmail: args.actor.email,
    action: AuditAction.SIGNING_OTP_REQUESTED,
    entity: subject.purpose === "DOCUMENT" ? "ClientDocument" : "LoanApplication",
    entityId: subject.subjectId,
    newValue: {
      challengeId,
      purpose: subject.purpose,
      method: args.method,
      documentSha256: subject.documentSha256,
      channel,
      maskedDestination,
      deliveryStatus,
      ...(delivery.error ? { deliveryError: delivery.error } : {}),
      ...(reveal.demoCode ? { demoCodeRevealed: true } : {}),
    },
    ipAddress: args.ip ?? undefined,
  })

  if (deliveryStatus === "FAILED") {
    return {
      ok: false,
      status: 502,
      error: `We could not send a code by ${CHANNEL_LABEL[channel]}. Try another channel or contact your lender.`,
    }
  }
  if (deliveryStatus === "SIMULATED" && !reveal.demoCode) {
    return {
      ok: false,
      status: 503,
      error: "Messages are simulated on this deployment, so no code was sent. Contact your lender.",
    }
  }
  return {
    ok: true,
    challenge: { challengeId, channel, maskedDestination, expiresAt: expiresAt.toISOString(), ...reveal },
  }
}

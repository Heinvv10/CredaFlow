/**
 * Issue a signing OTP for a resolved subject (lib/signing-otp/subject.ts):
 * budget check + PENDING row (one serialised transaction), send, then settle
 * the row with the send's outcome.
 *
 * The budget is per subject and per client, counted in the database under a
 * per-client advisory lock, so parallel requests cannot all pass a count read
 * before any of them inserted. The row exists before the send, so a request
 * that dies mid-send still spent budget. The id is minted first because the
 * code hash and the message's idempotency key both bind to it. The database
 * lets deliveryStatus/sentAt move off PENDING once (guardSigningOtpChallenge).
 */
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAudit } from "@/lib/audit"
import { demoCodeReveal } from "@/lib/config/demo-mode"
import { generateOtp } from "@/lib/otp"
import { SIGNING_OTP_TEMPLATE_KEYS } from "@/lib/messaging/otp-templates"
import {
  SIGNING_OTP_CLIENT_REQUEST_LIMIT,
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

/**
 * A provider or pipeline error, fit for the server log and the audit row: an
 * error text may echo the recipient or the message, so email addresses and
 * digit runs (a phone number, the code itself) are masked, and it is capped.
 */
export function redactDeliveryError(text: string): string {
  return text
    .replace(/[^\s@"'<>]+@[^\s@"'<>]+/g, "[email]")
    .replace(/\d[\d\s-]{4,}\d/g, "[digits]")
    .slice(0, 300)
}

/**
 * Count the client's recent challenges (this subject, and all subjects) and
 * insert a PENDING one if both budgets allow, serialised per client. False
 * when a budget is spent.
 */
async function reservePendingChallenge(data: {
  id: string
  subject: SigningSubject
  codeHash: string
  channel: OtpChannel
  maskedDestination: string
  expiresAt: Date
  requestedByUserId: string | null
  requestedIp: string | null
  now: Date
}): Promise<boolean> {
  const { subject, now } = data
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`signing-otp:${subject.tenantId}:${subject.clientId}`}))`
    const since = (windowMs: number) => new Date(now.getTime() - windowMs)
    const base = { tenantId: subject.tenantId, clientId: subject.clientId }
    const [forSubject, forClient] = await Promise.all([
      tx.signingOtpChallenge.count({
        where: { ...base, purpose: subject.purpose, subjectId: subject.subjectId, createdAt: { gte: since(SIGNING_OTP_REQUEST_LIMIT.windowMs) } },
      }),
      tx.signingOtpChallenge.count({ where: { ...base, createdAt: { gte: since(SIGNING_OTP_CLIENT_REQUEST_LIMIT.windowMs) } } }),
    ])
    if (forSubject >= SIGNING_OTP_REQUEST_LIMIT.limit || forClient >= SIGNING_OTP_CLIENT_REQUEST_LIMIT.limit) return false
    await tx.signingOtpChallenge.create({
      data: {
        id: data.id,
        ...base,
        purpose: subject.purpose,
        subjectId: subject.subjectId,
        documentSha256: subject.documentSha256,
        codeHash: data.codeHash,
        channel: data.channel,
        maskedDestination: data.maskedDestination,
        deliveryStatus: "PENDING",
        sentAt: null,
        expiresAt: data.expiresAt,
        maxAttempts: SIGNING_OTP_MAX_ATTEMPTS,
        requestedByUserId: data.requestedByUserId,
        requestedIp: data.requestedIp,
        createdAt: now,
      },
    })
    return true
  })
}

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

  const challengeId = randomUUID()
  const code = generateOtp()
  const maskedDestination = maskDestination(channel, destination)
  const expiresAt = new Date(now.getTime() + SIGNING_OTP_TTL_MS)
  const reserved = await reservePendingChallenge({
    id: challengeId,
    subject,
    codeHash: hashSigningOtp(challengeId, code),
    channel,
    maskedDestination,
    expiresAt,
    requestedByUserId: args.method === "branch" ? args.actor.userId ?? null : null,
    requestedIp: args.ip,
    now,
  })
  if (!reserved) {
    return {
      ok: false,
      status: 429,
      error: "Too many codes requested. Wait a few minutes and try again.",
      retryAfterSeconds: SIGNING_OTP_REQUEST_LIMIT.windowMs / 1000,
    }
  }

  const delivery = await deliverOtp({
    tenantId: subject.tenantId,
    clientId: subject.clientId,
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
  }).catch((err: unknown) => ({ status: "FAILED" as const, error: err instanceof Error ? err.message : String(err) }))
  const deliveryError = delivery.error ? redactDeliveryError(delivery.error) : null
  if (deliveryError) {
    console.error("[signing-otp] code delivery failed:", { challengeId, channel, error: deliveryError })
  }

  // A demo borrower's .invalid mailbox never receives mail; there the screen
  // is the channel (lib/config/demo-mode.ts), recorded as SIMULATED.
  const reveal = channel === "EMAIL" ? demoCodeReveal(code, destination) : {}
  const deliveryStatus = delivery.status === "FAILED" && reveal.demoCode ? "SIMULATED" : delivery.status

  await prisma.signingOtpChallenge.updateMany({
    where: { id: challengeId, tenantId: subject.tenantId, deliveryStatus: "PENDING" },
    data: { deliveryStatus, sentAt: deliveryStatus === "FAILED" ? null : new Date() },
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
      ...(deliveryError ? { deliveryError } : {}),
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

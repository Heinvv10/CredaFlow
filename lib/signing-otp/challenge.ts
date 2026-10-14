/**
 * Signing OTP lifecycle: verify (attempt-counted) and consume (once, inside
 * the signing transaction). The request side is lib/signing-otp/request.ts.
 *
 * Every state change is a guarded updateMany whose WHERE restates the rule,
 * so two concurrent requests cannot both pass a check made on a stale read.
 * The database adds its own floor (migration w3_signing_otp_access_control):
 * attempts never exceed maxAttempts, a code is verified before it expires,
 * only a verified code is consumed, and a consumed row is frozen.
 */
import type { SigningOtpPurpose } from "@prisma/client"
import type { prisma as PrismaClientInstance } from "@/lib/prisma"
import { SIGNING_OTP_SIGN_WINDOW_MS, signingOtpMatches } from "./code"

type Db = Pick<typeof PrismaClientInstance, "signingOtpChallenge">

export type ChallengeState = {
  attempts: number
  maxAttempts: number
  expiresAt: Date
  verifiedAt: Date | null
  consumedAt: Date | null
  deliveryStatus: string
}

export type VerifyRefusal = "not_found" | "already_used" | "delivery_failed" | "expired" | "locked" | "wrong_code"

/** Why a code may not be tried at all right now; null when it may. */
export function verifyBlockedReason(row: ChallengeState, now: Date): Exclude<VerifyRefusal, "not_found" | "wrong_code"> | null {
  if (row.consumedAt) return "already_used"
  if (row.deliveryStatus === "FAILED") return "delivery_failed"
  if (now.getTime() >= row.expiresAt.getTime()) return "expired"
  if (row.attempts >= row.maxAttempts) return "locked"
  return null
}

export type SigningBinding = {
  tenantId: string
  clientId: string
  purpose: SigningOtpPurpose
  subjectId: string
  documentSha256: string
}

export type ConsumeRefusal = "not_found" | "not_verified" | "verification_stale" | "already_used" | "document_changed"

/** Why a challenge cannot authorise this signature; null when it can. */
export function consumeBlockedReason(
  row: (ChallengeState & SigningBinding) | null,
  binding: SigningBinding,
  now: Date,
): ConsumeRefusal | null {
  if (
    !row
    || row.tenantId !== binding.tenantId
    || row.clientId !== binding.clientId
    || row.purpose !== binding.purpose
    || row.subjectId !== binding.subjectId
  ) return "not_found"
  if (row.consumedAt) return "already_used"
  if (row.documentSha256 !== binding.documentSha256) return "document_changed"
  if (!row.verifiedAt) return "not_verified"
  if (now.getTime() - row.verifiedAt.getTime() > SIGNING_OTP_SIGN_WINDOW_MS) return "verification_stale"
  return null
}

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyRefusal; attemptsLeft?: number }

/**
 * Check a submitted code. Every try that reaches the comparison spends one
 * attempt first, atomically, so parallel guesses cannot exceed maxAttempts.
 */
export async function verifySigningOtp(
  db: Db,
  args: { tenantId: string; clientId: string; challengeId: string; code: string; now?: Date },
): Promise<VerifyResult> {
  const now = args.now ?? new Date()
  const where = { id: args.challengeId, tenantId: args.tenantId, clientId: args.clientId }
  const row = await db.signingOtpChallenge.findFirst({ where })
  if (!row) return { ok: false, reason: "not_found" }
  if (row.verifiedAt && !row.consumedAt) {
    return signingOtpMatches(row.id, args.code, row.codeHash) ? { ok: true } : { ok: false, reason: "wrong_code" }
  }
  const blocked = verifyBlockedReason(row, now)
  if (blocked) return { ok: false, reason: blocked }

  const spent = await db.signingOtpChallenge.updateMany({
    where: {
      ...where,
      attempts: { lt: row.maxAttempts },
      verifiedAt: null,
      consumedAt: null,
      deliveryStatus: { not: "FAILED" },
      expiresAt: { gt: now },
    },
    data: { attempts: { increment: 1 } },
  })
  if (spent.count !== 1) {
    const fresh = await db.signingOtpChallenge.findFirst({ where })
    if (fresh?.verifiedAt && !fresh.consumedAt && signingOtpMatches(fresh.id, args.code, fresh.codeHash)) return { ok: true }
    return { ok: false, reason: (fresh && verifyBlockedReason(fresh, now)) || "locked" }
  }
  if (!signingOtpMatches(row.id, args.code, row.codeHash)) {
    return { ok: false, reason: "wrong_code", attemptsLeft: Math.max(0, row.maxAttempts - row.attempts - 1) }
  }
  await db.signingOtpChallenge.updateMany({ where: { ...where, verifiedAt: null }, data: { verifiedAt: now } })
  return { ok: true }
}

export type SigningOtpEvidence = {
  challengeId: string
  channel: string
  maskedDestination: string
  deliveryStatus: string
  sentAt: string | null
  verifiedAt: string
  attempts: number
}

export class SigningOtpRefusedError extends Error {
  constructor(readonly reason: ConsumeRefusal | "required") {
    super(`Signing OTP refused: ${reason}`)
    this.name = "SigningOtpRefusedError"
  }
}

/**
 * Read-only pre-check for a clear refusal before a signing route does its
 * expensive work. consumeSigningOtp, inside the transaction, is the authority.
 */
export async function checkSigningOtp(
  db: Db,
  challengeId: string | null | undefined,
  binding: SigningBinding,
  now: Date = new Date(),
): Promise<ConsumeRefusal | "required" | null> {
  if (!challengeId) return "required"
  const row = await db.signingOtpChallenge.findFirst({ where: { id: challengeId, tenantId: binding.tenantId } })
  return consumeBlockedReason(row, binding, now)
}

/**
 * Spend a verified code on this signature, in the signing transaction. The
 * WHERE restates every binding, so a code verified for another client, another
 * subject or other bytes cannot sign this one. Returns the evidence the
 * signature record carries; throws SigningOtpRefusedError otherwise.
 */
export async function consumeSigningOtp(
  tx: Db,
  args: SigningBinding & { challengeId: string; method: "portal" | "branch"; now: Date },
): Promise<SigningOtpEvidence> {
  const { challengeId, method, now, ...binding } = args
  const consumed = await tx.signingOtpChallenge.updateMany({
    where: {
      id: challengeId,
      ...binding,
      verifiedAt: { not: null, gte: new Date(now.getTime() - SIGNING_OTP_SIGN_WINDOW_MS) },
      consumedAt: null,
    },
    data: { consumedAt: now, signingMethod: method },
  })
  if (consumed.count !== 1) {
    const row = await tx.signingOtpChallenge.findFirst({ where: { id: challengeId, tenantId: binding.tenantId } })
    throw new SigningOtpRefusedError(consumeBlockedReason(row, binding, now) ?? "already_used")
  }
  const row = await tx.signingOtpChallenge.findFirstOrThrow({ where: { id: challengeId, tenantId: binding.tenantId } })
  return {
    challengeId: row.id,
    channel: row.channel,
    maskedDestination: row.maskedDestination,
    deliveryStatus: row.deliveryStatus,
    sentAt: row.sentAt?.toISOString() ?? null,
    verifiedAt: row.verifiedAt!.toISOString(),
    attempts: row.attempts,
  }
}

/** What the borrower (or the witnessing staff member) is told for each refusal. */
export const SIGNING_OTP_REFUSAL_MESSAGES: Record<ConsumeRefusal | "required" | VerifyRefusal, string> = {
  required: "Verify the one-time code sent to you before signing.",
  not_found: "That one-time code request was not found. Request a new code.",
  not_verified: "Enter the one-time code sent to you before signing.",
  verification_stale: "Your code was verified too long ago. Request a new code and sign again.",
  already_used: "That code has already been used. Request a new code.",
  document_changed: "The document changed after the code was sent. Refresh, review it again and request a new code.",
  delivery_failed: "That code could not be delivered. Request a new code.",
  expired: "That code has expired. Request a new code.",
  locked: "Too many wrong codes. Request a new code.",
  wrong_code: "That code is not correct.",
}

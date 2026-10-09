import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { prisma } from "@/lib/prisma"

/**
 * One-time links that let a consumer capture a KYC selfie for ONE application
 * without a portal account.
 *
 * Deliberately modelled on lib/compliance/pasq-link-token.server.ts — same
 * secret handling, same one-active-token rule, same masked audit destination.
 * Divergence between the two is a smell: if one grows a control, so should the
 * other.
 *
 * 24h rather than the PASQ's 48h: this authorises a KYC act, and a shorter
 * window narrows the exposure of a credential sitting in a chat thread.
 */
export const SELFIE_LINK_TTL_MS = 24 * 60 * 60 * 1000
export type SelfieLinkChannel = "SMS" | "WHATSAPP" | "EMAIL"

const TOKEN_BYTES = 32
/** 32 random bytes rendered base64url — no padding, URL-safe. */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function isSelfieLinkSecret(value: unknown): value is string {
  return typeof value === "string" && SECRET_PATTERN.test(value)
}

export function hashSelfieLinkSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex")
}

function hexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
}

export interface MintedSelfieLink {
  id: string
  secret: string
  tokenHash: string
  expiresAt: Date
}

/**
 * Mints a token and invalidates every other active one for the application, so
 * only the most recently sent link can ever be used. Runs in the caller's
 * transaction when given one — and must, because the partial unique index
 * `SelfieCaptureToken_one_active_per_application` turns a concurrent mint into
 * a P2002 rather than into two live links.
 */
export async function mintSelfieLinkToken(
  tx: Pick<typeof prisma, "selfieCaptureToken">,
  args: {
    tenantId: string
    applicationId: string
    clientId: string
    channel: SelfieLinkChannel
    sentTo: string
    createdById: string
    now?: Date
  },
): Promise<MintedSelfieLink> {
  const now = args.now ?? new Date()
  const secret = randomBytes(TOKEN_BYTES).toString("base64url")
  const tokenHash = hashSelfieLinkSecret(secret)
  const expiresAt = new Date(now.getTime() + SELFIE_LINK_TTL_MS)

  await tx.selfieCaptureToken.updateMany({
    where: {
      tenantId: args.tenantId,
      applicationId: args.applicationId,
      usedAt: null,
      invalidatedAt: null,
    },
    data: { invalidatedAt: now },
  })
  const created = await tx.selfieCaptureToken.create({
    data: {
      tenantId: args.tenantId,
      applicationId: args.applicationId,
      clientId: args.clientId,
      tokenHash,
      channel: args.channel,
      sentTo: args.sentTo,
      expiresAt,
      createdById: args.createdById,
    },
    select: { id: true },
  })
  return { id: created.id, secret, tokenHash, expiresAt }
}

export type SelfieLinkRejection =
  | "malformed"
  | "unknown"
  | "expired"
  | "used"
  | "invalidated"
  | "application_changed"

export interface ResolvedSelfieLink {
  tokenId: string
  tenantId: string
  applicationId: string
  clientId: string
  clientFirstName: string
}

/**
 * Statuses during which a KYC selfie is still a meaningful act.
 *
 * DRAFT is excluded because nothing has been submitted to verify against;
 * everything past APPROVED (declined, cancelled, disbursed) is excluded because
 * a token minted earlier must not still be capturing identity evidence for a
 * decision that has already been taken.
 */
const CAPTURABLE_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "APPROVED"] as const

/**
 * Resolves a link secret to the application it may act on. Every condition is
 * re-read here rather than trusted from the token row, so a token cannot
 * outlive the state it was minted for.
 */
export async function resolveSelfieLinkToken(
  secret: string,
  now: Date = new Date(),
): Promise<
  { ok: true; link: ResolvedSelfieLink } | { ok: false; reason: SelfieLinkRejection }
> {
  if (!isSelfieLinkSecret(secret)) return { ok: false, reason: "malformed" }
  const tokenHash = hashSelfieLinkSecret(secret)
  const token = await prisma.selfieCaptureToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      tenantId: true,
      applicationId: true,
      clientId: true,
      tokenHash: true,
      expiresAt: true,
      usedAt: true,
      invalidatedAt: true,
    },
  })
  if (!token) return { ok: false, reason: "unknown" }
  // The unique index already located the row by digest; comparing the stored
  // digest back against the computed one in constant time keeps the check
  // independent of how the lookup is implemented.
  if (!hexEquals(token.tokenHash, tokenHash)) return { ok: false, reason: "unknown" }
  if (token.invalidatedAt) return { ok: false, reason: "invalidated" }
  if (token.usedAt) return { ok: false, reason: "used" }
  if (token.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" }

  // A cancelled, declined or disbursed application must not still accept a KYC
  // capture. Re-read rather than trusted from the token row.
  const application = await prisma.loanApplication.findFirst({
    where: {
      id: token.applicationId,
      tenantId: token.tenantId,
      clientId: token.clientId,
      status: { in: [...CAPTURABLE_STATUSES] },
    },
    select: { client: { select: { firstName: true } } },
  })
  if (!application) return { ok: false, reason: "application_changed" }

  return {
    ok: true,
    link: {
      tokenId: token.id,
      tenantId: token.tenantId,
      applicationId: token.applicationId,
      clientId: token.clientId,
      clientFirstName: application.client.firstName,
    },
  }
}

export const SELFIE_LINK_REJECTION_MESSAGE: Record<SelfieLinkRejection, string> = {
  malformed: "This link is not valid.",
  unknown: "This link is not valid.",
  expired: "This link has expired. Ask your consultant to send a new one.",
  used: "This link has already been used. Ask your consultant to send a new one.",
  invalidated: "A newer link was sent. Please use the most recent message.",
  application_changed: "This application is no longer awaiting a photo.",
}

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { prisma } from "@/lib/prisma"

/**
 * One-time links that let a consumer receive and acknowledge the PASQ without a
 * portal account (NCA s.92(1)).
 *
 * Origination is telephonic and online, so the consumer often exists only as a
 * phone number. The link is the delivery mechanism for the quotation; the
 * acknowledgement it produces is written by the same code as the portal's.
 *
 * The emitted secret is NEVER stored — only its SHA-256 — so a database read
 * cannot mint a working link.
 */

export const PASQ_LINK_TTL_MS = 48 * 60 * 60 * 1000
export type PasqLinkChannel = "SMS" | "WHATSAPP" | "EMAIL"

const TOKEN_BYTES = 32
/** 32 random bytes rendered base64url — no padding, URL-safe. */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function isPasqLinkSecret(value: unknown): value is string {
  return typeof value === "string" && SECRET_PATTERN.test(value)
}

export function hashPasqLinkSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex")
}

/** Keeps the last 4 digits (or, for an email, the first character and the
 * domain) so staff can confirm the destination in the audit trail without the
 * log itself becoming a directory of consumer contact details. */
export function maskDestination(destination: string): string {
  const at = destination.indexOf("@")
  if (at > 0) {
    return `${destination[0]}${"*".repeat(Math.max(1, at - 1))}${destination.slice(at)}`
  }
  const tail = destination.slice(-4)
  return `${"*".repeat(Math.max(0, destination.length - 4))}${tail}`
}

function hexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
}

export interface MintedPasqLink {
  id: string
  secret: string
  tokenHash: string
  expiresAt: Date
}

/**
 * Mints a token and invalidates every other active one for the application, so
 * only the most recently sent link can ever be used. Runs in the caller's
 * transaction when given one.
 */
export async function mintPasqLinkToken(
  tx: Pick<typeof prisma, "pasqAcknowledgementToken">,
  args: {
    tenantId: string
    applicationId: string
    clientId: string
    documentSha256: string
    channel: PasqLinkChannel
    sentTo: string
    createdById: string
    now?: Date
  },
): Promise<MintedPasqLink> {
  const now = args.now ?? new Date()
  const secret = randomBytes(TOKEN_BYTES).toString("base64url")
  const tokenHash = hashPasqLinkSecret(secret)
  const expiresAt = new Date(now.getTime() + PASQ_LINK_TTL_MS)

  await tx.pasqAcknowledgementToken.updateMany({
    where: {
      tenantId: args.tenantId,
      applicationId: args.applicationId,
      usedAt: null,
      invalidatedAt: null,
    },
    data: { invalidatedAt: now },
  })
  const created = await tx.pasqAcknowledgementToken.create({
    data: {
      tenantId: args.tenantId,
      applicationId: args.applicationId,
      clientId: args.clientId,
      documentSha256: args.documentSha256,
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

export type PasqLinkRejection =
  | "malformed"
  | "unknown"
  | "expired"
  | "used"
  | "invalidated"
  | "application_changed"

export interface ResolvedPasqLink {
  tokenId: string
  tenantId: string
  applicationId: string
  clientId: string
  clientEmail: string | null
  documentId: string
  documentSha256: string
  channel: string
}

/**
 * Resolves a link secret to the application it may act on.
 *
 * The token authorises exactly one thing: viewing and acknowledging the
 * quotation currently bound to its application, while that quotation is still
 * unacknowledged and no agreement exists. Every one of those conditions is
 * re-read here rather than trusted from the row, so a token cannot outlive the
 * state it was minted for.
 */
export async function resolvePasqLinkToken(
  secret: string,
  now: Date = new Date(),
): Promise<
  { ok: true; link: ResolvedPasqLink } | { ok: false; reason: PasqLinkRejection }
> {
  if (!isPasqLinkSecret(secret)) return { ok: false, reason: "malformed" }
  const tokenHash = hashPasqLinkSecret(secret)
  const token = await prisma.pasqAcknowledgementToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      tenantId: true,
      applicationId: true,
      clientId: true,
      documentSha256: true,
      tokenHash: true,
      channel: true,
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

  const application = await prisma.loanApplication.findFirst({
    where: {
      id: token.applicationId,
      tenantId: token.tenantId,
      clientId: token.clientId,
      status: "APPROVED",
      agreementGeneratedAt: null,
      pasqDocumentSha256: token.documentSha256,
      pasqAcknowledgedAt: null,
    },
    select: {
      pasqDocumentId: true,
      client: { select: { email: true } },
    },
  })
  if (!application?.pasqDocumentId) {
    return { ok: false, reason: "application_changed" }
  }

  return {
    ok: true,
    link: {
      tokenId: token.id,
      tenantId: token.tenantId,
      applicationId: token.applicationId,
      clientId: token.clientId,
      clientEmail: application.client.email,
      documentId: application.pasqDocumentId,
      documentSha256: token.documentSha256,
      channel: token.channel,
    },
  }
}

export const PASQ_LINK_REJECTION_MESSAGE: Record<PasqLinkRejection, string> = {
  malformed: "This link is not valid.",
  unknown: "This link is not valid.",
  expired: "This link has expired. Ask your consultant to send a new one.",
  used: "This quotation has already been acknowledged.",
  invalidated: "A newer quotation link was sent. Please use the most recent message.",
  application_changed:
    "This quotation is no longer the current one for your application. Ask your consultant to send a new link.",
}

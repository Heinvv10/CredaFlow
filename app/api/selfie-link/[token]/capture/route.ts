import { NextResponse, type NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { callerIp, checkRateLimit } from "@/lib/rate-limit"
import { captureSelfie } from "@/lib/kyc/selfie-capture.server"
import {
  hashSelfieLinkSecret,
  isSelfieLinkSecret,
  resolveSelfieLinkToken,
  SELFIE_LINK_REJECTION_MESSAGE,
  type SelfieLinkRejection,
} from "@/lib/kyc/selfie-link-token.server"
import { portalOffRefusal } from "@/lib/portal/portal-policy"

export const dynamic = "force-dynamic"

/**
 * Retries allowed against ONE link. The legitimate case is a consumer whose
 * photo was rejected for lighting or framing trying again a few times.
 *
 * Keyed per token rather than per IP because `callerIp` returns the literal
 * "unknown" unless TRUSTED_PROXY is set, and it is set nowhere in this repo —
 * so an IP-keyed bucket is one GLOBAL bucket shared by every consumer, and a
 * handful of simultaneous captures would 429 each other.
 *
 * The key is the token's SHA-256, never the secret: the limiter's store must
 * not become a place where live credentials sit in memory in plaintext.
 */
const PER_TOKEN_LIMIT = { limit: 10, windowMs: 10 * 60 * 1000 }

/**
 * Backstop against a flood of tokens that do not resolve.
 *
 * Charged ONLY when resolution fails, and therefore never able to refuse a
 * consumer holding a real link. That asymmetry is the whole point. Keying it on
 * `callerIp` looks like per-source limiting but is not: `callerIp` returns the
 * literal "unknown" unless TRUSTED_PROXY is set, and it is set nowhere in this
 * repo — so this is one bucket shared by the entire deployment.
 *
 * A shared bucket charged on EVERY request is worse than no bucket at all: it
 * hands an unauthenticated attacker a cheap lever to 429 every real consumer,
 * because a malformed token costs them nothing (isSelfieLinkSecret rejects it
 * before any database call). Charging only failures removes that lever and also
 * stops an organic traffic spike — many real applicants in one window — from
 * self-DoSing the feature, since successes never touch it.
 *
 * Residual, and NOT closed by this: the check below runs AFTER
 * resolveSelfieLinkToken, so it gates which response comes back, not whether
 * the query runs. Token-lookup volume is therefore UNBOUNDED by this code, not
 * capped at `limit` — an attacker sending well-formed-but-fake secrets drives
 * one indexed SELECT per request at whatever rate they sustain.
 *
 * ⚠️ DO NOT "fix" that by moving this check above resolveSelfieLinkToken.
 * Bounding the query that way necessarily refuses requests before knowing
 * whether the token is real, which hands back the exact denial vector this
 * asymmetry exists to remove: an attacker fills the shared bucket for free and
 * every consumer holding a valid link is refused. That regression is covered by
 * the test "a valid capture is not refused even when the shared bucket is
 * exhausted" — if you are reading this because that test went red, this comment
 * is the reason.
 *
 * There is no shared ceiling that is not also a cheap lever: 600/10min is one
 * request/second. Bounding query volume safely needs a trustworthy client
 * identity — TRUSTED_PROXY set for the real proxy topology — or volumetric
 * filtering at the proxy/CDN, which is the right layer for it. Escalated on the
 * PR as an infra decision.
 */
const UNRESOLVED_LIMIT = { limit: 600, windowMs: 10 * 60 * 1000 }

/**
 * Consumer-facing capture. The bearer token IS the authorisation, so the
 * tenant and client are taken from the token and NEVER from the request body —
 * a caller cannot aim someone else's capture at their own token.
 *
 * Reachable without a session only because /api/selfie-link/* is on the
 * public-operational allowlist (lib/public-routes.ts). Per that file's
 * contract, every route under this prefix MUST resolve the token through
 * `resolveSelfieLinkToken` before doing any work.
 */
const STATUS: Record<SelfieLinkRejection, number> = {
  malformed: 400,
  unknown: 404,
  expired: 410,
  used: 410,
  invalidated: 410,
  application_changed: 409,
}

export async function POST(
  req: NextRequest | Request,
  { params }: { params: Promise<{ token: string }> },
) {
  // Rate-limited before the token is even looked up: this endpoint is
  // unauthenticated and runs a VLM face match, so it must not become either a
  // probe oracle or a free compute pump.
  const { token } = await params
  const tooMany = NextResponse.json(
    { error: "Too many requests. Please wait a moment and try again." },
    { status: 429 },
  )
  // Only well-formed secrets get a per-token bucket; a malformed one would
  // otherwise let a scanner mint unlimited fresh keys and never be limited.
  if (isSelfieLinkSecret(token)) {
    const bucket = hashSelfieLinkSecret(token).slice(0, 32)
    if (!checkRateLimit(`selfie-link:capture:tok:${bucket}`, PER_TOKEN_LIMIT).allowed) {
      return tooMany
    }
  }
  const resolved = await resolveSelfieLinkToken(token)
  if (!resolved.ok) {
    // Charged here and nowhere else: a request that resolved to a real link has
    // already passed its own per-token bucket and must never be refused by a
    // bucket an attacker can fill.
    const ip = callerIp(req as NextRequest)
    if (!checkRateLimit(`selfie-link:capture:unresolved:${ip}`, UNRESOLVED_LIMIT).allowed) {
      return tooMany
    }
    return NextResponse.json(
      { error: SELFIE_LINK_REJECTION_MESSAGE[resolved.reason] },
      { status: STATUS[resolved.reason] },
    )
  }
  // The lender switched its portal off: its borrower-facing links close too.
  const portalOff = await portalOffRefusal(resolved.link.tenantId)
  if (portalOff) return portalOff

  // Parsed inside its own guard for the same reason the authenticated sibling
  // route is: a malformed or truncated multipart body — routine on the flaky
  // mobile connection a consumer is most likely using — throws here, and
  // without this it escapes as an unstructured 500 instead of the JSON error
  // the page knows how to display. This runs BEFORE the claim, so it can never
  // strand a token; it was missed when the sibling was fixed.
  let image: File | null
  try {
    const formData = await req.formData()
    image = formData.get("image") as File | null
  } catch (error) {
    console.error("Selfie capture link received an unreadable body:", error)
    return NextResponse.json({ error: "Failed to upload selfie" }, { status: 400 })
  }
  if (!image) {
    return NextResponse.json({ error: "image is required" }, { status: 400 })
  }

  // CLAIM the token before doing any work, with a compare-and-set on usedAt.
  // Resolving it as unused above is a read; two concurrent requests both pass
  // that read, and burning the token afterwards would leave both captures
  // already done — two ClientDocument rows and two VLM face matches from one
  // "single-use" link. A conditional updateMany makes the claim atomic: the
  // loser sees count 0 and is refused.
  const claim = await prisma.selfieCaptureToken.updateMany({
    where: {
      id: resolved.link.tokenId,
      tenantId: resolved.link.tenantId,
      usedAt: null,
      invalidatedAt: null,
    },
    data: { usedAt: new Date() },
  })
  if (claim.count === 0) {
    return NextResponse.json(
      { error: SELFIE_LINK_REJECTION_MESSAGE.used },
      { status: STATUS.used },
    )
  }

  // Once claimed, the row is in a middle state that only a release or a bind
  // resolves. If the write that resolves it throws, nothing anywhere reclaims
  // the row — resolveSelfieLinkToken checks usedAt BEFORE expiresAt, so it
  // would report "used" forever and never even age into "expired". Every exit
  // from here on therefore runs through this guard.
  const releaseClaim = () =>
    prisma.selfieCaptureToken.updateMany({
      where: {
        id: resolved.link.tokenId,
        tenantId: resolved.link.tenantId,
        documentId: null,
      },
      data: { usedAt: null },
    })

  try {
    return await captureAndBind(resolved.link, image, releaseClaim)
  } catch (error) {
    console.error("Selfie capture failed after the token was claimed:", error)
    // Best-effort release so an infrastructure blip does not dead-end a
    // consumer with a permanently unusable link. A duplicate selfie is the
    // worse-case cost and the biometric pipeline already resolves those by
    // latest-wins; a stranded link has no recovery at all.
    try {
      await releaseClaim()
    } catch (releaseError) {
      console.error(
        "Could not release a claimed selfie token — it is now stranded and the consumer needs a new link:",
        { tokenId: resolved.link.tokenId },
        releaseError,
      )
    }
    return NextResponse.json({ error: "Failed to upload selfie" }, { status: 500 })
  }
}

/**
 * The claimed-token critical section. Split out so the caller's try/catch
 * unambiguously covers every path between the claim and its resolution.
 */
async function captureAndBind(
  link: { tenantId: string; clientId: string; tokenId: string },
  image: File,
  releaseClaim: () => Promise<unknown>,
) {
  const result = await captureSelfie({
    tenantId: link.tenantId,
    clientId: link.clientId,
    image,
    // The consumer holding the link is the client on the token. There is no
    // session and no staff actor; attributing it to one would forge the
    // uploader.
    uploader: { type: "client", clientId: link.clientId, email: null },
  })
  if (!result.ok) {
    // RELEASE the claim: a rejected photo is the consumer's mistake to retry,
    // not a reason to make them ask for a new link. One helper, shared with the
    // caller's catch, so the two release sites cannot drift apart.
    await releaseClaim()
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  // Bind the burned token to what it produced. Best-effort on purpose: the
  // document is already committed and the face match already running, so
  // failing the response here would tell a consumer their accepted photo had
  // failed. The token stays burned either way, which is correct — it WAS used.
  // Only the convenience link back to the document is lost, so it is logged
  // rather than swallowed.
  try {
    await prisma.selfieCaptureToken.update({
      where: { id: link.tokenId },
      data: { documentId: result.documentId },
    })
  } catch (error) {
    console.error(
      "Selfie captured but the token could not be bound to its document:",
      { tokenId: link.tokenId, documentId: result.documentId },
      error,
    )
  }

  // Deliberately not the document body: the caller is unauthenticated, and the
  // stored row carries the client id, storage digest and extraction state.
  return NextResponse.json({ ok: true })
}

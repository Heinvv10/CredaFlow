import { type NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { readFile } from "@/lib/storage"
import { documentBytesMatchSha256 } from "@/lib/documents/content-integrity"
import { checkRateLimit, callerIp } from "@/lib/rate-limit"
import {
  PASQ_LINK_REJECTION_MESSAGE,
  resolvePasqLinkToken,
} from "@/lib/compliance/pasq-link-token.server"

type RouteCtx = { params: Promise<{ token: string }> }

const LINK_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 }

function problem(status: number, error: string) {
  return Response.json({ error }, { status })
}

/**
 * Streams the quotation to a consumer holding a one-time link.
 *
 * This is also what makes the acknowledgement lawful: the access log row it
 * writes is the evidence the quotation was actually put in front of the
 * consumer, which `recordPasqAcknowledgement` requires before it will record
 * anything. The accessor is the CLIENT, because the bytes go to the consumer's
 * own device — the same evidence shape the portal produces.
 */
export async function GET(req: NextRequest, { params }: RouteCtx) {
  const { token } = await params
  const ip = callerIp(req)
  if (!checkRateLimit(`pasq-link:doc:${ip}`, LINK_LIMIT).allowed) {
    return problem(429, "Too many requests. Please wait a moment and try again.")
  }

  const resolved = await resolvePasqLinkToken(token)
  if (!resolved.ok) {
    return problem(
      resolved.reason === "unknown" || resolved.reason === "malformed" ? 404 : 410,
      PASQ_LINK_REJECTION_MESSAGE[resolved.reason],
    )
  }
  const { link } = resolved

  const document = await prisma.clientDocument.findFirst({
    where: {
      id: link.documentId,
      tenantId: link.tenantId,
      clientId: link.clientId,
      docType: "FORM_20_PRE_AGREEMENT",
      deletedAt: null,
      storagePath: { not: null },
      contentSha256: link.documentSha256,
    },
    select: { id: true, storagePath: true },
  })
  if (!document?.storagePath) {
    return problem(422, "The quotation document is unavailable. Ask your consultant to send a new link.")
  }
  let bytes: Buffer
  try {
    bytes = await readFile(document.storagePath)
  } catch {
    return problem(422, "The quotation document is unavailable. Ask your consultant to send a new link.")
  }
  if (!documentBytesMatchSha256(bytes, link.documentSha256)) {
    return problem(422, "The quotation failed its integrity check and cannot be shown.")
  }

  // POPIA: every read of a client document is logged (lib/document-auth.ts does
  // this for session-bound reads; the token surface has no session, so it
  // writes the equivalent row itself).
  await prisma.documentAccessLog.create({
    data: {
      documentId: document.id,
      accessorType: "client",
      accessorId: link.clientId,
      action: "view",
      ipAddress: req.headers.get("x-forwarded-for") ?? null,
      userAgent: req.headers.get("user-agent") ?? null,
    },
  })

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="pre-agreement-quotation.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      // The URL carries the live bearer secret; a hyperlink clicked inside
      // the browser's PDF viewer must never leak it via Referer.
      "Referrer-Policy": "no-referrer",
    },
  })
}

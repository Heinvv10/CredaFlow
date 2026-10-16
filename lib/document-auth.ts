import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { recordedCallerIp } from "@/lib/rate-limit"
import type { UserRole } from "@prisma/client"

// Every tenant staff role (Hein, 2026-10-16). Operator roles are absent: they
// reach borrower rows only through a support grant (lib/operator/.claude.md).
const STAFF_ROLES: UserRole[] = [
  "SUPER_ADMIN",
  "ADMIN",
  "CREDIT_OFFICER",
  "LOAN_ADMIN",
  "COLLECTIONS_OFFICER",
  "COLLECTIONS_AGENT",
  "INSURANCE_OFFICER",
  "BRANCH_MANAGER",
  "READONLY",
]

export type CallerInfo =
  | { type: "staff"; userId: string; role: UserRole; tenantId: string | null }
  | { type: "client"; clientId: string; email: string }

export async function getDocumentCaller(): Promise<CallerInfo | null> {
  const session = await auth()
  if (!session?.user?.email) return null

  // Check if this is a staff user
  if (session.user.role && STAFF_ROLES.includes(session.user.role as UserRole)) {
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, role: true, tenantId: true, active: true },
    })
    if (user) {
      // The stored row decides, not the session: a deactivated user, or one
      // whose role has since left the staff list, gets no documents and never
      // falls through to the portal lookup below.
      if (!user.active || !STAFF_ROLES.includes(user.role)) return null
      return {
        type: "staff",
        userId: user.id,
        role: user.role,
        tenantId: user.tenantId,
      }
    }
    // A staff session whose user row is gone is not a portal client either.
    return null
  }

  // Check if this is a portal client. Document routes call this before the
  // request tenant wrapper is established, so include an explicit tenantId to
  // satisfy the tenant-scope guard instead of throwing before the upload starts.
  // The tenant is the one the portal session was issued for (the client's own
  // row), never the deployment default. No tenant on the session: no caller.
  const tenantId = session.user.tenantId
  if (!tenantId) return null
  const client = await prisma.client.findFirst({
    where: { email: session.user.email, tenantId },
    select: { id: true, email: true },
  })
  if (client) {
    return { type: "client", clientId: client.id, email: client.email }
  }

  return null
}

export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]

export const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

export const VALID_DOC_TYPES = [
  "ID_COPY",
  "PROOF_OF_ADDRESS",
  "PAYSLIP",
  "BANK_STATEMENT",
  "SELFIE",
  "PO_DOCUMENT",
  "PROOF_OF_PAYMENT",
  "OTHER",
] as const

// ── Magic-byte (file signature) validation ──────────────────────────────────
//
// Defence-in-depth against a spoofed Content-Type persisting a mislabeled file.
// Upload routes already reject a MIME that isn't in ALLOWED_MIME_TYPES; this
// additionally checks the actual file header matches the declared type (the
// same guard /api/portal/payment/manual already applies to proof-of-payment).
// Each MIME maps to a list of segments (offset + bytes) that must ALL match.
// WebP is RIFF (offset 0) + "WEBP" (offset 8), so it needs two segments — a
// plain RIFF prefix also matches WAV/AVI.
const FILE_SIGNATURES: Record<string, { offset: number; bytes: number[] }[]> = {
  "application/pdf": [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }], // %PDF
  "image/png": [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  "image/jpeg": [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  "image/webp": [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
    { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // WEBP
  ],
}

// Leading bytes a caller must read to cover every signature above.
export const MAGIC_BYTE_PREFIX = 12

/**
 * True when `head` (the file's leading bytes — pass up to MAGIC_BYTE_PREFIX)
 * matches the magic-byte signature for `mime`. Robust to a short `head`: an
 * out-of-range index reads `undefined`, which never equals a signature byte, so
 * a too-small buffer simply fails to match (fails closed, no throw). An
 * unknown/unsupported MIME also returns false — callers MIME-allow-list first,
 * so this fails closed if a new type is allow-listed without a signature.
 */
export function matchesMagic(head: Uint8Array, mime: string): boolean {
  const sig = FILE_SIGNATURES[mime]
  if (!sig) return false
  return sig.every((seg) => seg.bytes.every((b, i) => head[seg.offset + i] === b))
}

// ── Access logging (POPIA) ───────────────────────────────────────────────────
//
// One writer for a DocumentAccessLog row, shaped exactly like the row
// app/api/documents/[id]/view writes for a ClientDocument. Write it BEFORE the
// bytes are read, so an access that fails half-way is still on the register.
// The IP is recordedCallerIp (lib/rate-limit.ts): the address the trusted proxy saw,
// not the raw X-Forwarded-For, whose leading entries the caller writes.

export type DocumentAccessAction = "view" | "download"

export async function logDocumentAccess(
  db: Pick<typeof prisma, "documentAccessLog">,
  params: {
    documentId: string
    accessorType: "staff" | "client"
    accessorId: string
    action: DocumentAccessAction
    req: Request
  },
): Promise<void> {
  await db.documentAccessLog.create({
    data: {
      documentId: params.documentId,
      accessorType: params.accessorType,
      accessorId: params.accessorId,
      action: params.action,
      ipAddress: recordedCallerIp(params.req),
      userAgent: params.req.headers.get("user-agent") ?? null,
    },
  })
}

/**
 * Records that staff were shown content read out of client documents without
 * opening the file itself, e.g. statement transactions quoted as credit-check
 * evidence. One DocumentAccessLog row per document (POPIA).
 */
export async function logDocumentContentAccess(opts: {
  documentIds: string[]
  staffUserId: string
  action: string
  req: Request
}): Promise<void> {
  if (opts.documentIds.length === 0) return
  await prisma.documentAccessLog.createMany({
    data: [...new Set(opts.documentIds)].map((documentId) => ({
      documentId,
      accessorType: "staff",
      accessorId: opts.staffUserId,
      action: opts.action,
      ipAddress: recordedCallerIp(opts.req),
      userAgent: opts.req.headers.get("user-agent") ?? null,
    })),
  })
}

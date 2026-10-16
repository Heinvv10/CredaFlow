/**
 * The tenant's letterhead logo.
 *
 * One PNG per tenant, uploaded by an ADMIN in Settings → Lender identity and
 * printed on the NCA documents and in the staff shell. It is stored on disk,
 * content-addressed, at `uploads/tenant-logos/<tenantId>/<sha256>.png`, and
 * `TenantConfig.logoUrl` holds only an internal reference to the hash
 * (`tenant-logo:sha256:<hex>`), never a URL: nothing here ever fetches over
 * the network, so a value written by anything else prints no logo at all.
 *
 * Old files are kept when the logo changes. An issued document already carries
 * its logo in its own bytes, and the audit trail names each hash, so the file
 * behind any audited change can still be produced.
 *
 * A missing, unreadable or tampered file means "no logo": the documents fall
 * back to their text letterhead and the shell to the brand name.
 */
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { PDFDocument } from "pdf-lib"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"

export const LOGO_MAX_BYTES = 512 * 1024
export const LOGO_MAX_DIMENSION = 2000
/** Widest (or tallest) shape accepted. The documents scale a logo down to fit
 *  their letterhead (lib/pdf/helpers.ts fitLogo); past 8:1 it would print as
 *  an unreadable sliver. */
export const LOGO_MAX_ASPECT = 8

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const REFERENCE = /^tenant-logo:sha256:([0-9a-f]{64})$/
// Tenant ids are cuids; anything else could escape the logo directory.
const SAFE_TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/

export function logoStorageRoot(): string {
  return path.join(process.cwd(), "uploads", "tenant-logos")
}

export function logoReference(sha256: string): string {
  return `tenant-logo:sha256:${sha256}`
}

/** The hash a `logoUrl` refers to, or null for anything that is not our own reference. */
export function parseLogoReference(logoUrl: string | null | undefined): string | null {
  return REFERENCE.exec(logoUrl ?? "")?.[1] ?? null
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function logoPath(root: string, tenantId: string, hash: string): string {
  if (!SAFE_TENANT_ID.test(tenantId)) throw new Error("Refusing a logo path for an unsafe tenant id")
  return path.join(root, tenantId, `${hash}.png`)
}

export type LogoValidation = { ok: true; width: number; height: number } | { ok: false; error: string }

/**
 * Checks the bytes themselves, never a file name or a client-declared type:
 * the PNG signature, the size limits, and that pdf-lib can embed it (which is
 * what the documents will do with it).
 */
export async function validateLogoPng(bytes: Uint8Array): Promise<LogoValidation> {
  if (bytes.length > LOGO_MAX_BYTES) return { ok: false, error: "The logo must be at most 512 KB." }
  if (bytes.length < PNG_SIGNATURE.length || !Buffer.from(bytes.subarray(0, 8)).equals(PNG_SIGNATURE)) {
    return { ok: false, error: "The logo must be a PNG image." }
  }
  // The size the file declares (its IHDR chunk, always first), checked before
  // anything decodes it: a few KB of PNG can declare an image that inflates to
  // gigabytes.
  if (bytes.length < 24 || Buffer.from(bytes.subarray(12, 16)).toString("latin1") !== "IHDR") {
    return { ok: false, error: "The logo must be a PNG image." }
  }
  const declared = Buffer.from(bytes.subarray(16, 24))
  if (declared.readUInt32BE(0) > LOGO_MAX_DIMENSION || declared.readUInt32BE(4) > LOGO_MAX_DIMENSION) {
    return { ok: false, error: `The logo must be at most ${LOGO_MAX_DIMENSION}×${LOGO_MAX_DIMENSION} pixels.` }
  }
  let width: number
  let height: number
  try {
    const image = await (await PDFDocument.create()).embedPng(bytes)
    width = image.width
    height = image.height
  } catch {
    return { ok: false, error: "The logo could not be read as a PNG image." }
  }
  if (width > LOGO_MAX_DIMENSION || height > LOGO_MAX_DIMENSION) {
    return { ok: false, error: `The logo must be at most ${LOGO_MAX_DIMENSION}×${LOGO_MAX_DIMENSION} pixels.` }
  }
  if (Math.max(width / height, height / width) > LOGO_MAX_ASPECT) {
    return { ok: false, error: `The logo must be no wider or taller than ${LOGO_MAX_ASPECT}:1.` }
  }
  return { ok: true, width, height }
}

/** The app's Prisma client (or a test double with the same shape). */
export type LogoWriteDb = Pick<typeof prisma, "$transaction">
type LogoReadDb = { tenantConfig: { findUnique: (args: { where: { tenantId: string }; select: { logoUrl: true } }) => Promise<{ logoUrl: string | null } | null> } }

type Actor = { id: string; email: string }

/** Stores the logo and points the tenant at it; the change and its audit row commit together. */
export async function setLenderLogo(
  db: LogoWriteDb,
  args: { tenantId: string; actor: Actor; bytes: Uint8Array; ipAddress?: string; root?: string },
): Promise<{ ok: true; changed: boolean; sha256: string } | { ok: false; error: string }> {
  const { tenantId, actor, bytes, ipAddress, root = logoStorageRoot() } = args
  const file = (hash: string) => logoPath(root, tenantId, hash)
  file("0") // refuse an unsafe tenant id before validating or writing anything
  const valid = await validateLogoPng(bytes)
  if (!valid.ok) return valid
  const hash = sha256(bytes)

  // The file goes down first, under its own hash, so logoUrl can never name a
  // file that is not there. A write that then fails to commit leaves an
  // unreferenced file, which is harmless.
  await fs.mkdir(path.dirname(file(hash)), { recursive: true })
  const temp = `${file(hash)}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temp, bytes, { flag: "wx" })
  await fs.rename(temp, file(hash))

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "TenantConfig" WHERE "tenantId" = ${tenantId} FOR UPDATE`
    const stored = await tx.tenantConfig.findUnique({ where: { tenantId }, select: { logoUrl: true } })
    const previous = parseLogoReference(stored?.logoUrl)
    if (previous === hash) return { ok: true as const, changed: false, sha256: hash }
    await tx.tenantConfig.upsert({
      where: { tenantId },
      update: { logoUrl: logoReference(hash) },
      create: { tenantId, logoUrl: logoReference(hash) },
    })
    await logAuditStrict({
      tenantId,
      userId: actor.id,
      userEmail: actor.email,
      action: AuditAction.LENDER_LOGO_UPDATED,
      entity: "TenantConfig",
      entityId: tenantId,
      oldValue: { logoSha256: previous },
      newValue: { logoSha256: hash, width: valid.width, height: valid.height, bytes: bytes.length },
      ipAddress,
    }, tx)
    return { ok: true as const, changed: true, sha256: hash }
  })
}

/** Removes the tenant's logo (the documents return to the text letterhead); audited. */
export async function removeLenderLogo(
  db: LogoWriteDb,
  args: { tenantId: string; actor: Actor; ipAddress?: string },
): Promise<{ ok: true; changed: boolean }> {
  const { tenantId, actor, ipAddress } = args
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "TenantConfig" WHERE "tenantId" = ${tenantId} FOR UPDATE`
    const stored = await tx.tenantConfig.findUnique({ where: { tenantId }, select: { logoUrl: true } })
    if (!stored?.logoUrl) return { ok: true as const, changed: false }
    await tx.tenantConfig.upsert({ where: { tenantId }, update: { logoUrl: null }, create: { tenantId, logoUrl: null } })
    await logAuditStrict({
      tenantId,
      userId: actor.id,
      userEmail: actor.email,
      action: AuditAction.LENDER_LOGO_REMOVED,
      entity: "TenantConfig",
      entityId: tenantId,
      oldValue: { logoSha256: parseLogoReference(stored.logoUrl) },
      newValue: { logoSha256: null },
      ipAddress,
    }, tx)
    return { ok: true as const, changed: true }
  })
}

/** The hash of the tenant's current logo, or null. For cache-busting the shell's image URL. */
export async function getLenderLogoSha256(tenantId: string, db?: LogoReadDb): Promise<string | null> {
  const reader = db ?? (prisma as unknown as LogoReadDb)
  const config = await reader.tenantConfig.findUnique({ where: { tenantId }, select: { logoUrl: true } })
  return parseLogoReference(config?.logoUrl)
}

/**
 * The tenant's logo bytes for a document letterhead, or undefined. Never
 * throws for a missing or bad file and never reads over the network.
 */
export async function getLenderLogo(
  tenantId: string,
  deps: { db?: LogoReadDb; root?: string } = {},
): Promise<Uint8Array | undefined> {
  const hash = await getLenderLogoSha256(tenantId, deps.db)
  if (!hash) return undefined
  let bytes: Buffer
  try {
    bytes = await fs.readFile(logoPath(deps.root ?? logoStorageRoot(), tenantId, hash))
  } catch (e) {
    console.warn(`Lender logo for tenant ${tenantId} could not be read; printing the text letterhead.`, (e as Error).message)
    return undefined
  }
  if (sha256(bytes) !== hash) {
    console.warn(`Lender logo for tenant ${tenantId} does not match its hash; printing the text letterhead.`)
    return undefined
  }
  return new Uint8Array(bytes)
}

/**
 * The URL of the tenant's logo for the public website and the client portal
 * (app/api/website/logo), versioned by content so a new upload shows at once;
 * null when there is no readable logo, and the brand name shows instead.
 */
export async function publicLenderLogoSrc(tenantId: string): Promise<string | null> {
  const logo = await getLenderLogo(tenantId)
  return logo ? `/api/website/logo?v=${sha256(logo).slice(0, 12)}` : null
}

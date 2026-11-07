/**
 * The lender's public-website photos, stored the way the letterhead logo is
 * (lib/config/lender-logo.ts): on disk, content-addressed, at
 * `uploads/website-imagery/<tenantId>/<sha256>.<ext>`, with the slot's entry in
 * `TenantConfig.websiteImagery` (lib/config/website-imagery-schema.ts) naming
 * the hash. Every change commits with its audit row; old files are kept, since
 * the audit trail names each hash.
 *
 * A missing or tampered file means "no image" for that slot: the page renders
 * as it did before the lender uploaded anything.
 */
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { IMAGE_EXTENSION, IMAGE_MIME, inspectImage } from "./website-imagery-image"
import {
  PRODUCT_SLUGS,
  getSlotImage,
  parseWebsiteImagery,
  slotTextSchema,
  withSlot,
  type CommunityImage,
  type ImageFormat,
  type ImageryImage,
  type ImagerySlot,
  type ProductSlug,
  type SlotText,
  type WebsiteImagery,
} from "./website-imagery-schema"

// Tenant ids are cuids; anything else could escape the imagery directory.
const SAFE_TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/

export function imageryStorageRoot(): string {
  return path.join(process.cwd(), "uploads", "website-imagery")
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

function imagePath(root: string, tenantId: string, hash: string, format: ImageFormat): string {
  if (!SAFE_TENANT_ID.test(tenantId)) throw new Error("Refusing an imagery path for an unsafe tenant id")
  return path.join(root, tenantId, `${hash}.${IMAGE_EXTENSION[format]}`)
}

export type ImageryWriteDb = Pick<typeof prisma, "$transaction">
type Actor = { id: string | null; email: string }
type Failure = { ok: false; error: string }
export type ImageryChange = { ok: true; changed: boolean; sha256?: string }

/** What the website renders for a slot. */
export type ImageView = { src: string; alt: string; width: number; height: number }
export type WebsiteImageryView = {
  hero?: ImageView
  products: Partial<Record<ProductSlug, ImageView>>
  community?: ImageView & { heading: string; body: string }
}

function oldAndNew(slot: ImagerySlot, before: ImageryImage | CommunityImage | undefined, after: ImageryImage | CommunityImage | undefined) {
  return { oldValue: { slot, image: before ?? null }, newValue: { slot, image: after ?? null } }
}

async function lockedDocument(tx: Pick<typeof prisma, "$executeRaw" | "tenantConfig">, tenantId: string): Promise<WebsiteImagery | null> {
  await tx.$executeRaw`SELECT 1 FROM "TenantConfig" WHERE "tenantId" = ${tenantId} FOR UPDATE`
  const stored = await tx.tenantConfig.findUnique({ where: { tenantId }, select: { websiteImagery: true } })
  return parseWebsiteImagery(stored?.websiteImagery)
}

async function saveDocument(tx: Pick<typeof prisma, "tenantConfig">, tenantId: string, doc: WebsiteImagery | null): Promise<void> {
  const value = doc === null ? Prisma.DbNull : (doc as Prisma.InputJsonValue)
  await tx.tenantConfig.upsert({ where: { tenantId }, update: { websiteImagery: value }, create: { tenantId, websiteImagery: value } })
}

/** The text for a slot, checked against what the slot takes: a community band needs its heading and sentence, the others take neither. */
function checkText(slot: ImagerySlot, input: unknown): { ok: true; text: SlotText } | Failure {
  const parsed = slotTextSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Alt text is required (1 to 200 characters); a community heading is at most 80 and its sentence at most 240." }
  const { heading, body } = parsed.data
  if (slot === "community" && (!heading || !body)) return { ok: false, error: "The community band needs a heading and a sentence." }
  if (slot !== "community" && (heading || body)) return { ok: false, error: "Only the community band has a heading and a sentence." }
  return { ok: true, text: parsed.data }
}

function withText(image: ImageryImage, slot: ImagerySlot, text: SlotText): ImageryImage | CommunityImage {
  const base = { ...image, alt: text.alt }
  return slot === "community" ? { ...base, heading: text.heading as string, body: text.body as string } : base
}

/** Stores an image into a slot with its alt text (and, for the community band, heading and sentence); the change and its audit row commit together. */
export async function setWebsiteImage(
  db: ImageryWriteDb,
  args: { tenantId: string; actor: Actor; slot: ImagerySlot; bytes: Uint8Array; text: unknown; ipAddress?: string; root?: string },
): Promise<ImageryChange | Failure> {
  const { tenantId, actor, slot, bytes, ipAddress, root = imageryStorageRoot() } = args
  imagePath(root, tenantId, "0", "png") // refuse an unsafe tenant id before validating or writing anything
  const checked = checkText(slot, args.text)
  if (!checked.ok) return checked
  const inspected = inspectImage(bytes)
  if (!inspected.ok) return inspected
  const hash = sha256(bytes)
  const target = imagePath(root, tenantId, hash, inspected.format)

  // The file goes down first, under its own hash, so the document can never name a
  // file that is not there. A write that then fails to commit leaves an unreferenced file.
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temp, bytes, { flag: "wx" })
  await fs.rename(temp, target)

  const image = withText({ sha256: hash, format: inspected.format, width: inspected.width, height: inspected.height, alt: "" }, slot, checked.text)
  return db.$transaction(async (tx) => {
    const doc = await lockedDocument(tx, tenantId)
    const before = getSlotImage(doc, slot)
    if (before && JSON.stringify(before) === JSON.stringify(image)) return { ok: true as const, changed: false, sha256: hash }
    await saveDocument(tx, tenantId, withSlot(doc, slot, image))
    await logAuditStrict({
      tenantId, userId: actor.id ?? undefined, userEmail: actor.email, action: AuditAction.WEBSITE_IMAGE_UPDATED,
      entity: "TenantConfig", entityId: tenantId, ...oldAndNew(slot, before, image), ipAddress,
    }, tx)
    return { ok: true as const, changed: true, sha256: hash }
  })
}

/** Changes the text of a slot that already has an image (alt text, community heading and sentence); audited. */
export async function updateWebsiteImageText(
  db: ImageryWriteDb,
  args: { tenantId: string; actor: Actor; slot: ImagerySlot; text: unknown; ipAddress?: string },
): Promise<ImageryChange | Failure> {
  const { tenantId, actor, slot, ipAddress } = args
  const checked = checkText(slot, args.text)
  if (!checked.ok) return checked
  return db.$transaction(async (tx) => {
    const doc = await lockedDocument(tx, tenantId)
    const before = getSlotImage(doc, slot)
    if (!before) return { ok: false as const, error: "There is no image in that slot yet; upload one first." }
    const after = withText(before, slot, checked.text)
    if (JSON.stringify(before) === JSON.stringify(after)) return { ok: true as const, changed: false }
    await saveDocument(tx, tenantId, withSlot(doc, slot, after))
    await logAuditStrict({
      tenantId, userId: actor.id ?? undefined, userEmail: actor.email, action: AuditAction.WEBSITE_IMAGE_UPDATED,
      entity: "TenantConfig", entityId: tenantId, ...oldAndNew(slot, before, after), ipAddress,
    }, tx)
    return { ok: true as const, changed: true }
  })
}

/** Empties a slot (the page returns to how it looked without it); audited. */
export async function removeWebsiteImage(
  db: ImageryWriteDb,
  args: { tenantId: string; actor: Actor; slot: ImagerySlot; ipAddress?: string },
): Promise<ImageryChange> {
  const { tenantId, actor, slot, ipAddress } = args
  return db.$transaction(async (tx) => {
    const doc = await lockedDocument(tx, tenantId)
    const before = getSlotImage(doc, slot)
    if (!before) return { ok: true as const, changed: false }
    await saveDocument(tx, tenantId, withSlot(doc, slot, undefined))
    await logAuditStrict({
      tenantId, userId: actor.id ?? undefined, userEmail: actor.email, action: AuditAction.WEBSITE_IMAGE_REMOVED,
      entity: "TenantConfig", entityId: tenantId, ...oldAndNew(slot, before, undefined), ipAddress,
    }, tx)
    return { ok: true as const, changed: true }
  })
}

type ImageryReadDb = { tenantConfig: { findUnique: (args: { where: { tenantId: string }; select: { websiteImagery: true } }) => Promise<{ websiteImagery: unknown } | null> } }

/** The tenant's stored document (staff form), or null. */
export async function getWebsiteImageryDocument(tenantId: string, db?: ImageryReadDb): Promise<WebsiteImagery | null> {
  const reader = db ?? (prisma as unknown as ImageryReadDb)
  const config = await reader.tenantConfig.findUnique({ where: { tenantId }, select: { websiteImagery: true } })
  return parseWebsiteImagery(config?.websiteImagery)
}

/** An image's bytes, checked against its hash; undefined for anything missing or altered. */
export async function readWebsiteImage(
  tenantId: string,
  slot: ImagerySlot,
  deps: { db?: ImageryReadDb; root?: string } = {},
): Promise<{ bytes: Uint8Array; mime: string; sha256: string } | undefined> {
  const image = getSlotImage(await getWebsiteImageryDocument(tenantId, deps.db), slot)
  if (!image) return undefined
  let bytes: Buffer
  try {
    bytes = await fs.readFile(imagePath(deps.root ?? imageryStorageRoot(), tenantId, image.sha256, image.format))
  } catch (e) {
    console.warn(`Website image ${slot} for tenant ${tenantId} could not be read; leaving it out.`, (e as Error).message)
    return undefined
  }
  if (sha256(bytes) !== image.sha256) {
    console.warn(`Website image ${slot} for tenant ${tenantId} does not match its hash; leaving it out.`)
    return undefined
  }
  return { bytes: new Uint8Array(bytes), mime: IMAGE_MIME[image.format], sha256: image.sha256 }
}

export const imageryUrl = (slot: ImagerySlot, hash: string) => `/api/website/imagery/${slot}?v=${hash.slice(0, 12)}`

/**
 * What the public website renders: only slots whose file is on disk, with their
 * versioned URLs. Null when there is nothing to show (and when the read fails:
 * a photo never blanks the home page), so the page is exactly the one without images.
 */
export async function getWebsiteImageryView(tenantId: string, deps: { db?: ImageryReadDb; root?: string } = {}): Promise<WebsiteImageryView | null> {
  let doc: WebsiteImagery | null
  try {
    doc = await getWebsiteImageryDocument(tenantId, deps.db)
  } catch (e) {
    console.warn(`Website imagery for tenant ${tenantId} could not be read; rendering without it.`, (e as Error).message)
    return null
  }
  if (!doc) return null
  const root = deps.root ?? imageryStorageRoot()
  const present = async (image: ImageryImage): Promise<boolean> => {
    try {
      await fs.access(imagePath(root, tenantId, image.sha256, image.format))
      return true
    } catch {
      return false
    }
  }
  const view = (slot: ImagerySlot, image: ImageryImage): ImageView => ({ src: imageryUrl(slot, image.sha256), alt: image.alt, width: image.width, height: image.height })
  const result: WebsiteImageryView = { products: {} }
  if (doc.hero && (await present(doc.hero))) result.hero = view("hero", doc.hero)
  if (doc.community && (await present(doc.community))) result.community = { ...view("community", doc.community), heading: doc.community.heading, body: doc.community.body }
  for (const slug of PRODUCT_SLUGS) {
    const image = doc.products?.[slug]
    if (image && (await present(image))) result.products[slug] = view(`product-${slug}`, image)
  }
  return result.hero || result.community || Object.keys(result.products).length > 0 ? result : null
}

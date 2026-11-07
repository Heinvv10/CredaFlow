/**
 * The lender's public-website photos, stored the way the letterhead logo is
 * (lib/config/lender-logo.ts): on disk, content-addressed, at
 * `uploads/website-imagery/<tenantId>/<sha256>.<ext>`, with the slot's entry in
 * `TenantConfig.websiteImagery` (lib/config/website-imagery-schema.ts) naming
 * the hash. Every change commits with its audit row; old files are kept, since
 * the audit trail names each hash.
 *
 * The page never serves the upload itself: each upload is decoded and re-encoded
 * as 800 and 1920 px WebP copies without metadata (website-imagery-variants.ts),
 * stored beside it as `<sha256>.w800.webp` and `<sha256>.w1920.webp`. A removed
 * or replaced image's files stay on disk (lib/config/.claude.md says how to erase one).
 *
 * A missing file means "no image" for that slot: the page renders as it did
 * before the lender uploaded anything. A stored document that no longer matches
 * its shape is never written over (StoredImageryUnreadable).
 */
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { logger } from "@/lib/observability/logger"
import { IMAGE_EXTENSION, inspectImage } from "./website-imagery-image"
import { LARGEST_VARIANT, VARIANT_WIDTHS, makeVariants, type VariantWidth } from "./website-imagery-variants"
import {
  PRODUCT_SLUGS,
  getSlotImage,
  isUnreadableImagery,
  parseWebsiteImagery,
  slotTextSchema,
  withSlot,
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

/** The column holds something that is not a website-imagery document; writing would silently drop every slot in it. */
export class StoredImageryUnreadable extends Error {
  constructor(tenantId: string) {
    super(`The stored website images for tenant ${tenantId} do not match the expected shape; refusing to write over them.`)
    this.name = "StoredImageryUnreadable"
  }
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

function imagePath(root: string, tenantId: string, hash: string, format: ImageFormat): string {
  if (!SAFE_TENANT_ID.test(tenantId)) throw new Error("Refusing an imagery path for an unsafe tenant id")
  return path.join(root, tenantId, `${hash}.${IMAGE_EXTENSION[format]}`)
}

function variantPath(root: string, tenantId: string, hash: string, width: VariantWidth): string {
  if (!SAFE_TENANT_ID.test(tenantId)) throw new Error("Refusing an imagery path for an unsafe tenant id")
  return path.join(root, tenantId, `${hash}.w${width}.webp`)
}

async function writeAtomically(target: string, bytes: Uint8Array): Promise<void> {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temp, bytes, { flag: "wx" })
  await fs.rename(temp, target)
}

export type ImageryWriteDb = Pick<typeof prisma, "$transaction">
type Actor = { id: string | null; email: string }
type Failure = { ok: false; error: string }
export type ImageryChange = { ok: true; changed: boolean; sha256?: string }

/** What the website renders for a slot: the 1920 px copy as `src`, both copies as `srcSet`; `alt` is "" for a decorative product image. */
export type ImageView = { src: string; srcSet: string; alt: string; width: number; height: number }
export type WebsiteImageryView = {
  hero?: ImageView
  products: Partial<Record<ProductSlug, ImageView>>
  community?: ImageView & { heading: string; body: string }
}

function oldAndNew(slot: ImagerySlot, before: ImageryImage | undefined, after: ImageryImage | undefined) {
  return { oldValue: { slot, image: before ?? null }, newValue: { slot, image: after ?? null } }
}

async function lockedDocument(tx: Pick<typeof prisma, "$executeRaw" | "tenantConfig">, tenantId: string): Promise<WebsiteImagery | null> {
  await tx.$executeRaw`SELECT 1 FROM "TenantConfig" WHERE "tenantId" = ${tenantId} FOR UPDATE`
  const stored = await tx.tenantConfig.findUnique({ where: { tenantId }, select: { websiteImagery: true } })
  if (isUnreadableImagery(stored?.websiteImagery)) {
    logger.error("[website-imagery] the stored document does not match its shape; refusing to write", { tenantId })
    throw new StoredImageryUnreadable(tenantId)
  }
  return parseWebsiteImagery(stored?.websiteImagery)
}

async function saveDocument(tx: Pick<typeof prisma, "tenantConfig">, tenantId: string, doc: WebsiteImagery | null): Promise<void> {
  const value = doc === null ? Prisma.DbNull : (doc as Prisma.InputJsonValue)
  await tx.tenantConfig.upsert({ where: { tenantId }, update: { websiteImagery: value }, create: { tenantId, websiteImagery: value } })
}

/** The text for a slot, checked against what the slot takes: alt text except on a product card, a community band's heading and sentence and no other slot's. */
function checkText(slot: ImagerySlot, input: unknown): { ok: true; text: SlotText } | Failure {
  const parsed = slotTextSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Alt text is at most 200 characters; a community heading is at most 80 and its sentence at most 240." }
  const { alt, heading, body } = parsed.data
  if (!slot.startsWith("product-") && alt === "") return { ok: false, error: "Alt text is required for this image." }
  if (slot === "community" && (!heading || !body)) return { ok: false, error: "The community band needs a heading and a sentence." }
  if (slot !== "community" && (heading || body)) return { ok: false, error: "Only the community band has a heading and a sentence." }
  return { ok: true, text: parsed.data }
}

function withText(image: ImageryImage, slot: ImagerySlot, text: SlotText): ImageryImage {
  const { alt: _alt, ...rest } = image
  const base = text.alt === "" ? rest : { ...rest, alt: text.alt }
  return slot === "community" ? ({ ...base, alt: text.alt, heading: text.heading as string, body: text.body as string } as ImageryImage) : (base as ImageryImage)
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
  const variants = await makeVariants(bytes)
  if (!variants.ok) return variants
  const hash = sha256(bytes)
  const target = imagePath(root, tenantId, hash, inspected.format)

  // The files go down first, under the upload's hash, so the document can never name a
  // file that is not there. A write that then fails to commit leaves unreferenced files.
  await fs.mkdir(path.dirname(target), { recursive: true })
  await writeAtomically(target, bytes)
  for (const width of VARIANT_WIDTHS) await writeAtomically(variantPath(root, tenantId, hash, width), variants.files[width])

  const image = withText({ sha256: hash, format: inspected.format, width: variants.width, height: variants.height, alt: "" }, slot, checked.text)
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

/** The tenant's stored document (staff form), or null; a column that does not match the shape is logged, not hidden. */
export async function getWebsiteImageryDocument(tenantId: string, db?: ImageryReadDb): Promise<WebsiteImagery | null> {
  const reader = db ?? (prisma as unknown as ImageryReadDb)
  const config = await reader.tenantConfig.findUnique({ where: { tenantId }, select: { websiteImagery: true } })
  if (isUnreadableImagery(config?.websiteImagery)) {
    logger.error("[website-imagery] the stored document does not match its shape; showing no images", { tenantId })
  }
  return parseWebsiteImagery(config?.websiteImagery)
}

/** One served copy of a slot's image (WebP, `width` px wide), or undefined when the slot is empty or the file is missing. */
export async function readWebsiteImage(
  tenantId: string,
  slot: ImagerySlot,
  deps: { db?: ImageryReadDb; root?: string; width?: VariantWidth } = {},
): Promise<{ bytes: Uint8Array; mime: string; sha256: string } | undefined> {
  const image = getSlotImage(await getWebsiteImageryDocument(tenantId, deps.db), slot)
  if (!image) return undefined
  try {
    const bytes = await fs.readFile(variantPath(deps.root ?? imageryStorageRoot(), tenantId, image.sha256, deps.width ?? LARGEST_VARIANT))
    return { bytes: new Uint8Array(bytes), mime: "image/webp", sha256: image.sha256 }
  } catch (e) {
    logger.warn(`[website-imagery] ${slot} for tenant ${tenantId} could not be read; leaving it out.`, { reason: (e as Error).message })
    return undefined
  }
}

export const imageryUrl = (slot: ImagerySlot, hash: string, width?: VariantWidth) =>
  `/api/website/imagery/${slot}?v=${hash.slice(0, 12)}${width ? `&w=${width}` : ""}`

/**
 * What the public website renders: only slots whose served file is on disk, with
 * their versioned URLs. Null when there is nothing to show (and when the read
 * fails: a photo never blanks the home page), so the page is exactly the one
 * without images.
 */
export async function getWebsiteImageryView(tenantId: string, deps: { db?: ImageryReadDb; root?: string } = {}): Promise<WebsiteImageryView | null> {
  let doc: WebsiteImagery | null
  try {
    doc = await getWebsiteImageryDocument(tenantId, deps.db)
  } catch (e) {
    logger.warn(`[website-imagery] the images for tenant ${tenantId} could not be read; rendering without them.`, { reason: (e as Error).message })
    return null
  }
  if (!doc) return null
  const root = deps.root ?? imageryStorageRoot()
  const present = async (image: ImageryImage): Promise<boolean> => {
    try {
      await fs.access(variantPath(root, tenantId, image.sha256, LARGEST_VARIANT))
      return true
    } catch {
      return false
    }
  }
  const view = (slot: ImagerySlot, image: ImageryImage): ImageView => ({
    src: imageryUrl(slot, image.sha256, LARGEST_VARIANT),
    srcSet: VARIANT_WIDTHS.map((w) => `${imageryUrl(slot, image.sha256, w)} ${w}w`).join(", "),
    alt: image.alt ?? "",
    width: image.width,
    height: image.height,
  })
  const result: WebsiteImageryView = { products: {} }
  if (doc.hero && (await present(doc.hero))) result.hero = view("hero", doc.hero)
  if (doc.community && (await present(doc.community))) result.community = { ...view("community", doc.community), heading: doc.community.heading, body: doc.community.body }
  for (const slug of PRODUCT_SLUGS) {
    const image = doc.products?.[slug]
    if (image && (await present(image))) result.products[slug] = view(`product-${slug}`, image)
  }
  return result.hero || result.community || Object.keys(result.products).length > 0 ? result : null
}

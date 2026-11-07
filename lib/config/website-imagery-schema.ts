/**
 * The lender's public-website photos: the shape stored in
 * `TenantConfig.websiteImagery`, the slots, and the limits. Pure (no database,
 * no filesystem), so the staff form, the website and the demo loader all read
 * the same definition. lib/config/website-imagery.ts stores and serves them.
 *
 * Three slots, nothing else: the home-page hero, one optional image per loan
 * product card, and an optional community band (image, heading, one sentence).
 * The hero and the community image carry the alt text their lender wrote; a
 * product card's image sits inside the card's link and its title, so its alt
 * text is optional (empty = decorative). A document that names a slot this file
 * does not know, or a hero or community image without alt text, is refused.
 */
import { z } from "zod"
import type { PublicLoanProductCode } from "@/lib/public-loan-products"

export const IMAGERY_MAX_BYTES = 3 * 1024 * 1024
export const IMAGERY_MAX_DIMENSION = 6000
export const ALT_MAX = 200
export const COMMUNITY_HEADING_MAX = 80
export const COMMUNITY_BODY_MAX = 240

export const IMAGE_FORMATS = ["jpeg", "png", "webp"] as const
export type ImageFormat = (typeof IMAGE_FORMATS)[number]

/** The loan-product card keys on the home page (PublicLoanProduct.code). */
export const PRODUCT_SLUGS = ["short-term", "personal", "purchase-order", "invoice-discounting"] as const
// A product added to the public catalogue must be added here too (or this stops compiling).
const _productSlugsCoverTheCatalogue: PublicLoanProductCode extends (typeof PRODUCT_SLUGS)[number] ? true : never = true
void _productSlugsCoverTheCatalogue
export type ProductSlug = (typeof PRODUCT_SLUGS)[number]

export type ImagerySlot = "hero" | "community" | `product-${ProductSlug}`

const text = (max: number) => z.string().trim().min(1).max(max)

const imageShape = {
  /** sha256 of the uploaded file's bytes: its name on disk, and the cache-busting version of its URL. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** The uploaded file's format (the page is served resized WebP variants of it). */
  format: z.enum(IMAGE_FORMATS),
  /** Size of the largest served variant, as displayed (after any EXIF rotation). */
  width: z.number().int().min(1).max(IMAGERY_MAX_DIMENSION),
  height: z.number().int().min(1).max(IMAGERY_MAX_DIMENSION),
}

const requiredAlt = { alt: text(ALT_MAX) }
const imageSchema = z.strictObject({ ...imageShape, ...requiredAlt })
const productImageSchema = z.strictObject({ ...imageShape, alt: z.string().trim().max(ALT_MAX).optional() })
const communitySchema = z.strictObject({
  ...imageShape,
  ...requiredAlt,
  heading: text(COMMUNITY_HEADING_MAX),
  body: text(COMMUNITY_BODY_MAX),
})

export const websiteImagerySchema = z.strictObject({
  hero: imageSchema.optional(),
  products: z
    .strictObject({
      "short-term": productImageSchema.optional(),
      personal: productImageSchema.optional(),
      "purchase-order": productImageSchema.optional(),
      "invoice-discounting": productImageSchema.optional(),
    })
    .optional(),
  community: communitySchema.optional(),
})

export type WebsiteImagery = z.infer<typeof websiteImagerySchema>
export type HeroImage = z.infer<typeof imageSchema>
export type ProductImage = z.infer<typeof productImageSchema>
export type CommunityImage = z.infer<typeof communitySchema>
/** What any slot holds; `alt` is optional only on a product's image. */
export type ImageryImage = HeroImage | ProductImage | CommunityImage

/** The text the lender writes for a slot: alt text (required except on a product card), plus a heading and sentence for the community band. */
export const slotTextSchema = z.strictObject({
  alt: z.string().trim().max(ALT_MAX).default(""),
  heading: text(COMMUNITY_HEADING_MAX).optional(),
  body: text(COMMUNITY_BODY_MAX).optional(),
})
export type SlotText = z.infer<typeof slotTextSchema>

export const ALL_SLOTS: readonly ImagerySlot[] = ["hero", ...PRODUCT_SLUGS.map((s) => `product-${s}` as const), "community"]

export function parseSlot(value: string): ImagerySlot | null {
  return (ALL_SLOTS as readonly string[]).includes(value) ? (value as ImagerySlot) : null
}

/** The stored document, or null for a column that is empty or no longer matches the shape. */
export function parseWebsiteImagery(value: unknown): WebsiteImagery | null {
  if (value === null || value === undefined) return null
  const parsed = websiteImagerySchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** True for a column that holds something but not a document of this shape: reading it as "empty" and then writing would wipe it. */
export function isUnreadableImagery(value: unknown): boolean {
  return value !== null && value !== undefined && !websiteImagerySchema.safeParse(value).success
}

export function isEmptyImagery(imagery: WebsiteImagery | null): boolean {
  return !imagery || (!imagery.hero && !imagery.community && !Object.values(imagery.products ?? {}).some(Boolean))
}

export function getSlotImage(imagery: WebsiteImagery | null, slot: ImagerySlot): ImageryImage | undefined {
  if (!imagery) return undefined
  if (slot === "hero") return imagery.hero
  if (slot === "community") return imagery.community
  return imagery.products?.[slot.slice("product-".length) as ProductSlug]
}

/** A copy of the document with one slot set (or cleared when `image` is undefined). */
export function withSlot(imagery: WebsiteImagery | null, slot: ImagerySlot, image: ImageryImage | undefined): WebsiteImagery | null {
  const next: WebsiteImagery = { ...imagery }
  if (slot === "hero") next.hero = image as HeroImage | undefined
  else if (slot === "community") next.community = image as CommunityImage | undefined
  else next.products = { ...imagery?.products, [slot.slice("product-".length)]: image as ProductImage | undefined }
  if (next.hero === undefined) delete next.hero
  if (next.community === undefined) delete next.community
  if (next.products) {
    for (const key of Object.keys(next.products) as ProductSlug[]) if (next.products[key] === undefined) delete next.products[key]
    if (Object.keys(next.products).length === 0) delete next.products
  }
  return isEmptyImagery(next) ? null : next
}

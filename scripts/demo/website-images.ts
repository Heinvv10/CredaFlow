/**
 * Reads a directory of website photos and writes them through the product's own
 * storage, validation and audit path (lib/config/website-imagery.ts), exactly as
 * an ADMIN's upload in Settings → Lender identity → Website images would.
 *
 * The directory holds one file per slot, named for the slot, with any of the
 * extensions .jpg .jpeg .png .webp (the type is read from the bytes, not the
 * name), and a manifest.json with the words each slot needs:
 *
 *   hero.jpg   product-personal.jpg   product-short-term.jpg   community.jpg   manifest.json
 *   { "hero": { "alt": "…" },
 *     "product-personal": { "alt": "…" },
 *     "community": { "alt": "…", "heading": "…", "body": "…" } }
 *
 * Slots: hero, community, product-short-term, product-personal,
 * product-purchase-order, product-invoice-discounting. A slot with a file needs
 * a manifest entry and the reverse; slots not in the directory are left as they are.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { setWebsiteImage, type ImageryWriteDb } from "../../lib/config/website-imagery"
import { ALL_SLOTS, parseSlot, slotTextSchema, type ImagerySlot } from "../../lib/config/website-imagery-schema"

const EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"]
const manifestSchema = z.record(z.string(), slotTextSchema)

export type ImageEntry = { slot: ImagerySlot; file: string; bytes: Uint8Array; text: z.infer<typeof slotTextSchema> }

/** Every slot's file and words, or the list of everything wrong with the directory. */
export function loadImageDir(dir: string): { entries: ImageEntry[]; errors: string[] } {
  const errors: string[] = []
  const manifestFile = path.join(dir, "manifest.json")
  if (!existsSync(manifestFile)) return { entries: [], errors: [`${manifestFile} is missing`] }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(manifestFile, "utf8"))
  } catch (e) {
    return { entries: [], errors: [`${manifestFile} is not JSON: ${(e as Error).message}`] }
  }
  const manifest = manifestSchema.safeParse(raw)
  if (!manifest.success) return { entries: [], errors: [`${manifestFile}: ${manifest.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`] }

  const files = new Map<ImagerySlot, string>()
  for (const name of readdirSync(dir)) {
    const ext = path.extname(name).toLowerCase()
    if (!EXTENSIONS.includes(ext)) continue
    const slot = parseSlot(path.basename(name, path.extname(name)))
    if (!slot) errors.push(`${name}: not a slot (${ALL_SLOTS.join(", ")})`)
    else if (files.has(slot)) errors.push(`${name}: a second file for ${slot}`)
    else files.set(slot, name)
  }
  for (const key of Object.keys(manifest.data)) {
    if (!parseSlot(key)) errors.push(`manifest.json: ${key} is not a slot`)
    else if (!files.has(key as ImagerySlot)) errors.push(`manifest.json: ${key} has no image file`)
  }
  for (const [slot, name] of files) if (!manifest.data[slot]) errors.push(`${name}: no manifest.json entry for ${slot}`)
  if (errors.length > 0) return { entries: [], errors }

  const entries = ALL_SLOTS.filter((slot) => files.has(slot)).map((slot) => {
    const file = files.get(slot) as string
    return { slot, file, bytes: new Uint8Array(readFileSync(path.join(dir, file))), text: manifest.data[slot] }
  })
  return { entries, errors: [] }
}

/** Writes each entry; returns what changed, or the first refusal (nothing after it is written). */
export async function applyImageDir(
  db: ImageryWriteDb,
  args: { tenantId: string; entries: ImageEntry[]; root?: string },
): Promise<{ ok: true; written: string[]; unchanged: string[] } | { ok: false; error: string }> {
  const written: string[] = []
  const unchanged: string[] = []
  for (const entry of args.entries) {
    const result = await setWebsiteImage(db, {
      tenantId: args.tenantId,
      actor: { id: null, email: "system:set-website-images" },
      slot: entry.slot,
      bytes: entry.bytes,
      text: entry.text,
      root: args.root,
    })
    if (!result.ok) return { ok: false, error: `${entry.file}: ${result.error}` }
    ;(result.changed ? written : unchanged).push(entry.slot)
  }
  return { ok: true, written, unchanged }
}

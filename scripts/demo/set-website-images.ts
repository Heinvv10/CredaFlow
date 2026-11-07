/**
 * npx tsx scripts/demo/set-website-images.ts <tenant-slug> <directory>
 * npx tsx scripts/demo/set-website-images.ts --check <directory>      (validates only; no database)
 *
 * Sets a demo lender's website photos from a directory (format: website-images.ts).
 * Reads DATABASE_URL and writes the files under ./uploads/website-imagery, so it
 * runs where the app's uploads volume is mounted: bake.sh runs it in the sim
 * stack's seed container (sim/seed-faked.sh) when DEMO_LENDER_IMAGES is set.
 * Exit 0 done, 2 the directory or tenant is wrong, 1 any other failure.
 */
import { PrismaClient } from "@prisma/client"
import type { ImageryWriteDb } from "../../lib/config/website-imagery"
import { applyImageDir, loadImageDir } from "./website-images"

function say(text: string): void {
  process.stderr.write(`${text}\n`)
}

/** The directory's problems, or its slots; the bake runs this before it spends 35 minutes. */
function check(dir: string | undefined): number {
  if (!dir) {
    say("usage: set-website-images.ts --check <directory>")
    return 1
  }
  const loaded = loadImageDir(dir)
  if (loaded.errors.length > 0) {
    say(`INVALID ${dir}:\n${loaded.errors.map((e) => `  - ${e}`).join("\n")}`)
    return 2
  }
  say(`${dir}: ${loaded.entries.map((e) => e.slot).join(", ") || "no images"}`)
  return 0
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args[0] === "--check") return check(args[1])
  const [slug, dir] = args
  if (!slug || !dir) {
    say("usage: set-website-images.ts <tenant-slug> <directory>")
    return 1
  }
  if (process.env.NODE_ENV === "production") {
    say("refused: NODE_ENV=production (a real lender sets its images in Settings → Lender identity)")
    return 2
  }
  if (!process.env.DATABASE_URL) {
    say("DATABASE_URL is not set.")
    return 1
  }
  const loaded = loadImageDir(dir)
  if (loaded.errors.length > 0) {
    say(`INVALID ${dir}:\n${loaded.errors.map((e) => `  - ${e}`).join("\n")}`)
    return 2
  }
  const db = new PrismaClient()
  try {
    const tenant = await db.tenant.findUnique({ where: { slug }, select: { id: true } })
    if (!tenant) {
      say(`No tenant with slug "${slug}".`)
      return 2
    }
    // The bare client, not the app's tenant-scoped one: TenantConfig is not tenant-scoped and every write names its tenant.
    const result = await applyImageDir(db as unknown as ImageryWriteDb, { tenantId: tenant.id, entries: loaded.entries })
    if (!result.ok) {
      say(`REFUSED ${result.error}`)
      return 2
    }
    say(`website images for "${slug}": ${result.written.length} written (${result.written.join(", ") || "-"}), ${result.unchanged.length} unchanged`)
    return 0
  } finally {
    await db.$disconnect()
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    say(`FAILED ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
    process.exit(1)
  },
)

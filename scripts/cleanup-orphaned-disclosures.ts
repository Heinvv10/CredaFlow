import { readdir, stat, unlink } from "node:fs/promises"
import path from "node:path"

const UPLOADS_ROOT = path.join(process.cwd(), "uploads", "disclosures")
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/**
 * Scans uploads/disclosures/<tenantId>/*.pdf and removes files older than MAX_AGE_MS.
 * Cleanup is best-effort — individual file errors are silently skipped so a single
 * unreadable file cannot abort the run.
 */
export async function cleanupOrphanedDisclosures(): Promise<{
  scanned: number
  removed: number
}> {
  let scanned = 0
  let removed = 0
  let tenants: string[] = []

  try {
    tenants = await readdir(UPLOADS_ROOT)
  } catch {
    // Directory doesn't exist yet — nothing to clean up
    return { scanned: 0, removed: 0 }
  }

  const now = Date.now()

  for (const tenantId of tenants) {
    const tenantDir = path.join(UPLOADS_ROOT, tenantId)
    let files: string[] = []

    try {
      files = await readdir(tenantDir)
    } catch {
      continue
    }

    for (const file of files) {
      if (!file.endsWith(".pdf")) continue
      scanned++

      const filePath = path.join(tenantDir, file)
      const s = await stat(filePath).catch(() => null)
      if (!s) continue

      if (now - s.mtimeMs > MAX_AGE_MS) {
        await unlink(filePath).catch(() => null)
        removed++
      }
    }
  }

  return { scanned, removed }
}

/**
 * Encrypt the files lib/storage.ts wrote before UPLOADS_ENC_KEY was set.
 *
 *   UPLOADS_ENC_KEY=… npm run uploads:encrypt -- [--dir <uploads-dir>] [--dry-run | --verify]
 *
 * Idempotent: a file that is already encrypted is skipped, so a rerun (or a
 * run interrupted half way) is safe. Covers the files directly in the uploads
 * directory and the insurance disclosure PDFs under disclosures/. Not entered:
 * tenant-logos/ (public logos, served by lib/config/lender-logo.ts and kept in
 * plaintext on purpose), and dot-directories (.restore-*, .pre-restore-*).
 *
 * Each file is encrypted into a temp file with a random name in the same
 * directory, read back and decrypted, compared with the original byte for
 * byte, given the original's mode and owner, fsynced and renamed over the
 * original: a reader sees the old plaintext or the new ciphertext, never a
 * half-written file, and the app reads both (lib/storage.ts readFile). Temp
 * files left by an interrupted run are deleted first. Each file's AAD is its
 * path under the uploads directory, exactly as lib/storage.ts binds it.
 *
 * Set UPLOADS_ENC_KEY on the app and redeploy (with UPLOADS_ENC_REQUIRED=false
 * while plaintext files remain) BEFORE running this. In a lender stack, run it
 * through scripts/lender/encrypt-uploads.sh.
 */
import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { classifyFile, decryptFile, encryptFile } from "../lib/storage-crypto"

/** Sub-directories converted along with the top level; anything else is reported, not entered. */
const ENCRYPTED_SUBDIRS = new Set(["disclosures"])
const TEMP_PATTERN = /^\..+\.enc-[0-9a-f]{16}$/

export interface EncryptUploadsResult {
  encrypted: string[]
  alreadyEncrypted: number
  skippedEntries: string[]
  staleTempsRemoved: number
  failed: Array<{ file: string; error: string }>
}

interface Entry { abs: string; name: string }

/** The files to consider, with their AAD names, and the entries not entered. */
async function listFiles(root: string): Promise<{ files: Entry[]; skipped: string[]; temps: string[] }> {
  const files: Entry[] = [], skipped: string[] = [], temps: string[] = []
  const walk = async (dir: string, rel: string, depth: number) => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = rel ? `${rel}/${e.name}` : e.name
      if (e.isFile() && TEMP_PATTERN.test(e.name)) temps.push(path.join(dir, e.name))
      else if (e.isFile() && !e.name.startsWith(".")) files.push({ abs: path.join(dir, e.name), name })
      else if (e.isDirectory() && !e.name.startsWith(".") && (depth > 0 || ENCRYPTED_SUBDIRS.has(e.name))) await walk(path.join(dir, e.name), name, depth + 1)
      else skipped.push(name)
    }
  }
  await walk(root, "", 0)
  return { files, skipped, temps }
}

export async function encryptUploads(dir: string, master: Buffer, dryRun: boolean): Promise<EncryptUploadsResult> {
  const { files, skipped, temps } = await listFiles(dir)
  const result: EncryptUploadsResult = { encrypted: [], alreadyEncrypted: 0, skippedEntries: skipped, staleTempsRemoved: 0, failed: [] }
  if (!dryRun) {
    for (const t of temps) await fs.rm(t, { force: true })
    result.staleTempsRemoved = temps.length
  }
  for (const f of files) {
    try {
      const bytes = await fs.readFile(f.abs)
      const kind = classifyFile(bytes, master, f.name)
      if (kind === "encrypted") {
        result.alreadyEncrypted++
        continue
      }
      // Never wrap an envelope in another one: a file under another key, or a
      // damaged one, is reported for a person to look at.
      if (kind === "other-key") throw new Error("encrypted with a different UPLOADS_ENC_KEY; left as it is")
      if (kind === "tampered") throw new Error("encrypted but fails its integrity check; left as it is")
      if (!dryRun) await replaceWithEncrypted(f, bytes, master)
      result.encrypted.push(f.name)
    } catch (error) {
      result.failed.push({ file: f.name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

export interface VerifyUploadsResult {
  opened: number
  plaintext: number
  failed: Array<{ file: string; error: string }>
}

/** Read-only: every encrypted file must open with `master` under its name (the restore drill runs this). */
export async function verifyUploads(dir: string, master: Buffer): Promise<VerifyUploadsResult> {
  const result: VerifyUploadsResult = { opened: 0, plaintext: 0, failed: [] }
  for (const f of (await listFiles(dir)).files) {
    try {
      const kind = classifyFile(await fs.readFile(f.abs), master, f.name)
      if (kind === "plaintext") result.plaintext++
      else if (kind === "encrypted") result.opened++
      else result.failed.push({ file: f.name, error: kind === "other-key" ? "encrypted with a different key" : "fails its integrity check" })
    } catch (error) {
      result.failed.push({ file: f.name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

async function replaceWithEncrypted(f: Entry, plain: Buffer, master: Buffer): Promise<void> {
  const sealed = encryptFile(plain, master, f.name)
  if (!decryptFile(sealed, master, f.name).equals(plain)) throw new Error("read-back mismatch; file left as it was")
  const stat = await fs.stat(f.abs)
  // A random suffix: two runs (or a leftover of a crashed one) never collide.
  const tmp = path.join(path.dirname(f.abs), `.${path.basename(f.abs)}.enc-${randomBytes(8).toString("hex")}`)
  const handle = await fs.open(tmp, "wx", stat.mode & 0o777)
  try {
    await handle.writeFile(sealed)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    if (process.getuid?.() === 0) await fs.chown(tmp, stat.uid, stat.gid)
    const check = await fs.readFile(tmp)
    if (!decryptFile(check, master, f.name).equals(plain)) throw new Error("temp file failed its read-back; file left as it was")
    // The app may delete a file (a retention or DSAR erasure) while it is being
    // converted: renaming over a deleted name would bring its bytes back. Check
    // it is still the same file immediately before the rename.
    const now = await fs.stat(f.abs).catch(() => null)
    if (!now || now.ino !== stat.ino || now.size !== stat.size || now.mtimeMs !== stat.mtimeMs) {
      throw new Error("file changed or was deleted during conversion; left as it is")
    }
    await fs.rename(tmp, f.abs)
  } catch (error) {
    await fs.rm(tmp, { force: true })
    throw error
  }
}

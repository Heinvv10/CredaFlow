/**
 * Encrypt the files lib/storage.ts wrote before UPLOADS_ENC_KEY was set.
 *
 *   UPLOADS_ENC_KEY=… npm run uploads:encrypt -- [--dir <uploads-dir>] [--dry-run]
 *
 * Idempotent: a file that is already encrypted is skipped, so a rerun (or a
 * run interrupted half way) is safe. Only regular files directly in the
 * uploads directory are touched (the flat layout lib/storage.ts writes);
 * sub-directories (disclosures/, tenant-logos/) belong to other writers and
 * are reported, not entered.
 *
 * Each file is encrypted into a temp file in the same directory, read back and
 * decrypted, compared with the original byte for byte, given the original's
 * mode and owner, fsynced and renamed over the original: a reader sees the old
 * plaintext or the new ciphertext, never a half-written file, and the app
 * reads both (lib/storage.ts readFile). Set UPLOADS_ENC_KEY on the app and
 * redeploy BEFORE running this, or the app cannot read what it converts.
 *
 * In a lender stack, run it through scripts/lender/encrypt-uploads.sh.
 */
import fs from "node:fs/promises"
import path from "node:path"
import { decryptFile, encryptFile, isEncryptedFile } from "../lib/storage-crypto"

export interface EncryptUploadsResult {
  encrypted: string[]
  alreadyEncrypted: number
  skippedEntries: string[]
  failed: Array<{ file: string; error: string }>
}

export async function encryptUploads(dir: string, master: Buffer, dryRun: boolean): Promise<EncryptUploadsResult> {
  const result: EncryptUploadsResult = { encrypted: [], alreadyEncrypted: 0, skippedEntries: [], failed: [] }
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || entry.name.startsWith(".")) {
      result.skippedEntries.push(entry.name)
      continue
    }
    const file = path.join(dir, entry.name)
    try {
      const plain = await fs.readFile(file)
      if (isEncryptedFile(plain)) {
        result.alreadyEncrypted++
        continue
      }
      if (!dryRun) await replaceWithEncrypted(file, plain, master)
      result.encrypted.push(entry.name)
    } catch (error) {
      result.failed.push({ file: entry.name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

export interface VerifyUploadsResult {
  opened: number
  plaintext: number
  failed: Array<{ file: string; error: string }>
}

/** Read-only: every encrypted file must open with `master` (the restore drill runs this). */
export async function verifyUploads(dir: string, master: Buffer): Promise<VerifyUploadsResult> {
  const result: VerifyUploadsResult = { opened: 0, plaintext: 0, failed: [] }
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue
    try {
      const bytes = await fs.readFile(path.join(dir, entry.name))
      if (!isEncryptedFile(bytes)) {
        result.plaintext++
        continue
      }
      decryptFile(bytes, master)
      result.opened++
    } catch (error) {
      result.failed.push({ file: entry.name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

async function replaceWithEncrypted(file: string, plain: Buffer, master: Buffer): Promise<void> {
  const sealed = encryptFile(plain, master)
  if (!decryptFile(sealed, master).equals(plain)) throw new Error("read-back mismatch; file left as it was")
  const stat = await fs.stat(file)
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.enc-${process.pid}`)
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
    if (!decryptFile(check, master).equals(plain)) throw new Error("temp file failed its read-back; file left as it was")
    // The app may delete a file (a retention or DSAR erasure) while it is being
    // converted: renaming over a deleted name would bring its bytes back. Check
    // it is still the same file immediately before the rename.
    const now = await fs.stat(file).catch(() => null)
    if (!now || now.ino !== stat.ino || now.size !== stat.size || now.mtimeMs !== stat.mtimeMs) {
      throw new Error("file changed or was deleted during conversion; left as it is")
    }
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true })
    throw error
  }
}

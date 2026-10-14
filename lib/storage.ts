import path from "path"
import fs from "fs/promises"
import { randomUUID } from "crypto"
import { decryptFile, encryptFile, isEncryptedFile, StorageCryptoError, uploadsMasterKey } from "@/lib/storage-crypto"

const UPLOAD_DIR = path.join(process.cwd(), "uploads")

/**
 * The bytes written to disk: envelope-encrypted when UPLOADS_ENC_KEY is set
 * (lib/storage-crypto.ts), the plaintext otherwise. Callers always see the
 * plaintext and its length; encryption is invisible above this module.
 */
function atRest(buffer: Buffer): Buffer {
  const key = uploadsMasterKey()
  return key ? encryptFile(buffer, key) : buffer
}

/** Whether new files are encrypted at rest (reported by /api/health). */
export function storageEncryptionEnabled(): boolean {
  return uploadsMasterKey() !== null
}

function extensionForMime(mimeType: string): string {
  return mimeType === "application/pdf"
    ? ".pdf"
    : mimeType.startsWith("image/")
      ? "." + mimeType.split("/")[1]
      : ".bin"
}

/**
 * Resolve a caller-owned managed-storage key before bytes are written. This
 * lets regulated workflows durably index the exact destination first, so an
 * interrupted DB/file handoff cannot create an untraceable PII blob.
 */
export function managedStoragePath(storageKey: string, mimeType: string): string {
  if (!/^[A-Za-z0-9_-]{16,160}$/.test(storageKey)) {
    throw new Error("Invalid managed storage key")
  }
  return path.join(UPLOAD_DIR, storageKey + extensionForMime(mimeType))
}

export async function saveFileToManagedPath(
  buffer: Buffer,
  mimeType: string,
  storageKey: string,
): Promise<{ storagePath: string; fileSize: number }> {
  const storagePath = managedStoragePath(storageKey, mimeType)
  await fs.mkdir(UPLOAD_DIR, { recursive: true })
  await fs.writeFile(storagePath, atRest(buffer), { flag: "wx" })
  return { storagePath, fileSize: buffer.length }
}

export async function saveFile(
  buffer: Buffer,
  mimeType: string
): Promise<{ storagePath: string; fileSize: number }> {
  await fs.mkdir(UPLOAD_DIR, { recursive: true })
  const ext = extensionForMime(mimeType)
  const filename = randomUUID() + ext
  const storagePath = path.join(UPLOAD_DIR, filename)
  await fs.writeFile(storagePath, atRest(buffer))
  return { storagePath, fileSize: buffer.length }
}

export async function deleteFile(storagePath: string): Promise<void> {
  try {
    await fs.unlink(storagePath)
  } catch {
    // File already gone
  }
}

/**
 * Delete a file that was created through managedStoragePath(). Unlike the
 * legacy best-effort delete helper, this fails on permission/I/O errors so a
 * regulated workflow cannot release its database retention control while PII
 * bytes remain on disk. ENOENT is idempotent success.
 */
export async function deleteManagedFileStrict(storagePath: string): Promise<void> {
  const managedRoot = path.resolve(UPLOAD_DIR)
  const resolvedPath = path.resolve(storagePath)
  if (path.dirname(resolvedPath) !== managedRoot) {
    throw new Error("Refusing to delete a file outside managed storage")
  }
  try {
    await fs.unlink(resolvedPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

/**
 * The plaintext of a stored file. An encrypted file is decrypted and its
 * integrity checked (a tampered file throws StorageCryptoError); a file
 * written before encryption was switched on is returned as stored, until
 * scripts/encrypt-uploads.ts has converted it.
 */
export async function readFile(storagePath: string): Promise<Buffer> {
  const bytes = await fs.readFile(storagePath)
  if (!isEncryptedFile(bytes)) return bytes
  const key = uploadsMasterKey()
  if (!key) throw new StorageCryptoError(`${path.basename(storagePath)} is encrypted but UPLOADS_ENC_KEY is not set`)
  return decryptFile(bytes, key)
}

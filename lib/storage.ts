import path from "path"
import fs from "fs/promises"
import { randomUUID } from "crypto"
import {
  decryptFile,
  encryptFile,
  hasEncryptionMagic,
  StorageCryptoError,
  uploadsEncryptionRequired,
  uploadsMasterKey,
} from "@/lib/storage-crypto"

const UPLOAD_DIR = path.join(process.cwd(), "uploads")

/**
 * A stored file's name for its encryption AAD: its path under the uploads
 * root, "/"-separated. Binding it means a file moved or swapped under another
 * name no longer decrypts. scripts/encrypt-uploads.ts computes the same.
 */
export function storageName(storagePath: string): string {
  return path.relative(path.resolve(UPLOAD_DIR), path.resolve(storagePath)).split(path.sep).join("/")
}

/**
 * The bytes written to disk: envelope-encrypted when UPLOADS_ENC_KEY is set
 * (lib/storage-crypto.ts). Without a key: plaintext, unless encryption is
 * required (UPLOADS_ENC_REQUIRED=true, set explicitly: provision-lender.sh does for
 * new lenders), when the write is refused. Callers always see the plaintext and
 * its length; encryption is invisible above this module.
 */
function atRest(buffer: Buffer, storagePath: string): Buffer {
  const key = uploadsMasterKey()
  if (key) return encryptFile(buffer, key, storageName(storagePath))
  if (uploadsEncryptionRequired()) {
    throw new StorageCryptoError("refusing to write an upload in plaintext: UPLOADS_ENC_KEY is not set and encryption at rest is required")
  }
  return buffer
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
  await fs.writeFile(storagePath, atRest(buffer, storagePath), { flag: "wx" })
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
  await fs.writeFile(storagePath, atRest(buffer, storagePath))
  return { storagePath, fileSize: buffer.length }
}

function relativeSegments(relativePath: string): string[] {
  const segments = relativePath.split("/")
  if (segments.length < 2 || !segments.every((s) => /^[A-Za-z0-9_.-]{1,255}$/.test(s) && s !== "." && s !== "..")) {
    throw new Error("Invalid storage path")
  }
  return segments
}

/** The absolute path of a file kept at a fixed path under the uploads root. */
export function storagePathAt(relativePath: string): string {
  return path.join(UPLOAD_DIR, ...relativeSegments(relativePath))
}

/**
 * Write a file at a fixed path under the uploads root (the insurance
 * disclosure PDFs: `disclosures/<tenantId>/<name>.pdf`), encrypted like every
 * other upload. Each segment must be a plain name: no "..", no separators.
 */
export async function saveFileAt(relativePath: string, buffer: Buffer): Promise<{ storagePath: string; fileSize: number }> {
  const storagePath = storagePathAt(relativePath)
  await fs.mkdir(path.dirname(storagePath), { recursive: true })
  await fs.writeFile(storagePath, atRest(buffer, storagePath))
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
 * The plaintext of a stored file. Anything carrying the encryption marker is
 * decrypted and checked, and a malformed, tampered or renamed one throws
 * StorageCryptoError (fail closed: never returned as if it were plaintext).
 * A file without the marker was written before encryption was on: it is
 * returned as stored until scripts/encrypt-uploads.ts converts it, and refused
 * once encryption at rest is required.
 */
export async function readFile(storagePath: string): Promise<Buffer> {
  const bytes = await fs.readFile(storagePath)
  if (!hasEncryptionMagic(bytes)) {
    if (uploadsEncryptionRequired()) {
      throw new StorageCryptoError(`${path.basename(storagePath)} is stored in plaintext and encryption at rest is required (run scripts/lender/encrypt-uploads.sh)`)
    }
    return bytes
  }
  const key = uploadsMasterKey()
  if (!key) throw new StorageCryptoError(`${path.basename(storagePath)} is encrypted but UPLOADS_ENC_KEY is not set`)
  return decryptFile(bytes, key, storageName(storagePath))
}

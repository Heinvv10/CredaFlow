import path from "path"
import fs from "fs/promises"
import { randomUUID } from "crypto"

const UPLOAD_DIR = path.join(process.cwd(), "uploads")

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
  await fs.writeFile(storagePath, buffer, { flag: "wx" })
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
  await fs.writeFile(storagePath, buffer)
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

export async function readFile(storagePath: string): Promise<Buffer> {
  return fs.readFile(storagePath)
}

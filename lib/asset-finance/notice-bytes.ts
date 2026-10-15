import { documentBytesMatchSha256 } from "@/lib/documents/content-integrity"
import { readFile } from "@/lib/storage"

/** A stored notice's bytes, read back and checked against the digest kept with them; a mismatch throws. */
export async function readVerified(path: string, sha256: string, label: string): Promise<{ bytes: Buffer; sha256: string }> {
  const bytes = await readFile(path)
  if (!documentBytesMatchSha256(bytes, sha256)) throw new Error(`${label} bytes failed integrity check`)
  return { bytes, sha256 }
}

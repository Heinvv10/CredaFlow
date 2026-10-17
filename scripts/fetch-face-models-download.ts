import { createHash } from "node:crypto"
import { appendFile, rename, rm, writeFile } from "node:fs/promises"

/** Official servers may ignore Range only on the first request. Never mix a
 * full response with accumulated ranges; verify every boundary and the final
 * pinned digest before atomically publishing a file. Failed attempts leave
 * any existing target untouched and remove their partial file.
 */
export async function downloadPinnedFile(
  target: string,
  model: { url: string; sha256: string },
  fetcher: typeof fetch = fetch,
  chunkSize = 1024 * 1024,
): Promise<number> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error("Invalid download chunk size")
  const partial = `${target}.partial`
  const hash = createHash("sha256")
  let offset = 0
  let total: number | undefined
  try {
    await writeFile(partial, new Uint8Array())
    do {
      const requestedEnd = total === undefined ? offset + chunkSize - 1 : Math.min(offset + chunkSize - 1, total - 1)
      const response = await fetcher(model.url, { headers: { Range: `bytes=${offset}-${requestedEnd}` } })
      let expectedLength: number | undefined
      if (response.status === 206) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "")
        const [start, end, size] = match ? match.slice(1).map(Number) : []
        if (!match || ![start, end, size].every(Number.isSafeInteger) || start !== offset || size <= end || end !== Math.min(requestedEnd, size - 1) || (total !== undefined && total !== size)) {
          await response.body?.cancel()
          throw new Error(`Invalid Content-Range at byte ${offset}`)
        }
        total = size
        expectedLength = end - start + 1
      } else if (response.status === 200 && offset === 0) {
        // The final pinned digest remains authoritative for servers without ranges.
        const length = response.headers.get("content-length")
        if (length !== null) {
          if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) {
            await response.body?.cancel()
            throw new Error("Invalid Content-Length")
          }
          expectedLength = Number(length)
        }
      } else {
        await response.body?.cancel()
        throw new Error(`HTTP ${response.status} at byte ${offset} from ${model.url}`)
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      const declaredLength = response.headers.get("content-length")
      if ((expectedLength !== undefined && bytes.length !== expectedLength) || (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== bytes.length))) {
        throw new Error(`Truncated or inconsistent response at byte ${offset}: got ${bytes.length} bytes`)
      }
      hash.update(bytes)
      await appendFile(partial, bytes)
      offset += bytes.length
      if (response.status === 200) total = offset
    } while (total !== undefined && offset < total)
    const digest = hash.digest("hex")
    if (digest !== model.sha256) throw new Error(`sha256 ${digest}, expected ${model.sha256} (got ${offset} bytes)`)
    await rename(partial, target)
    return offset
  } finally {
    await rm(partial, { force: true })
  }
}

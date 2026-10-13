/**
 * Every page of a PDF as a JPEG, for the vision reader. lib/vlm-extract.ts
 * renders page 1 only; a statement's rows run across all of them.
 *
 * The same containment as documentImage(): private temp dir, address-space
 * ceiling, discarded stderr, and each render checked against the size asked
 * for, because pdftoppm exits 0 after writing a 1x1 stub of a page it refused.
 */
import {
  MAX_RENDER_MEMORY_KB,
  cropBoxPt,
  isFullPageRender,
  jpegSizePx,
  renderTargetPx,
  withPrivateTempDir,
} from "@/lib/vlm-extract"

export async function renderPdfPages(bytes: Buffer, pageCount: number): Promise<Buffer[]> {
  const { execFile, execFileSync } = await import("child_process")
  const { readFileSync, writeFileSync } = await import("fs")
  const { join } = await import("path")
  return withPrivateTempDir(async (dir) => {
    const input = join(dir, "in.pdf")
    writeFileSync(input, bytes, { mode: 0o600 })
    // Page 1's box sizes every page: statements are printed on one paper size.
    const { widthPt, heightPt, quarterTurned } = cropBoxPt(input, execFileSync)
    const target = renderTargetPx(widthPt, heightPt)
    const expected = quarterTurned ? { widthPx: target.heightPx, heightPx: target.widthPx } : target
    const out: Buffer[] = []
    for (let page = 1; page <= pageCount; page++) {
      const prefix = join(dir, `p${page}`)
      // Asynchronous: one page can take seconds, and the process serves other requests meanwhile.
      await new Promise<void>((resolve, reject) => {
        execFile(
          "sh",
          [
            "-c",
            `ulimit -v ${MAX_RENDER_MEMORY_KB}; ` +
              `exec pdftoppm -f ${page} -l ${page} -scale-to-x ${target.widthPx} -scale-to-y ${target.heightPx} ` +
              `-jpeg -cropbox -singlefile "$1" "$2" >/dev/null 2>&1`,
            "sh",
            input,
            prefix,
          ],
          { timeout: 30_000 },
          (err) => (err ? reject(err) : resolve()),
        )
      })
      const jpeg = readFileSync(`${prefix}.jpg`)
      if (!isFullPageRender(jpeg, expected)) {
        const got = jpegSizePx(jpeg)
        throw new Error(`page ${page} rendered ${got.widthPx}x${got.heightPx}px, expected ${expected.widthPx}x${expected.heightPx}px`)
      }
      out.push(jpeg)
    }
    return out
  })
}

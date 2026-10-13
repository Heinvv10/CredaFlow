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

/**
 * cropBoxPt's geometry probe, run asynchronously: the same pdfinfo call under
 * the same limits, its output handed to cropBoxPt to parse, so a slow or
 * hostile file never blocks the event loop.
 */
async function pageBox(input: string, execFile: typeof import("child_process").execFile) {
  const out = await new Promise<string>((resolve, reject) => {
    execFile(
      "sh",
      ["-c", `ulimit -v ${MAX_RENDER_MEMORY_KB}; exec pdfinfo -box "$1"`, "sh", input],
      { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    )
  })
  return boxFrom(out)
}

function boxFrom(pdfinfoOutput: string) {
  return cropBoxPt("", (() => pdfinfoOutput) as unknown as typeof import("child_process").execFileSync)
}

export async function renderPdfPages(bytes: Buffer, pageCount: number): Promise<Buffer[]> {
  const { execFile } = await import("child_process")
  const { readFileSync, writeFileSync } = await import("fs")
  const { join } = await import("path")
  return withPrivateTempDir(async (dir) => {
    const input = join(dir, "in.pdf")
    writeFileSync(input, bytes, { mode: 0o600 })
    // Page 1's box sizes every page: statements are printed on one paper size.
    const { widthPt, heightPt, quarterTurned } = await pageBox(input, execFile)
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

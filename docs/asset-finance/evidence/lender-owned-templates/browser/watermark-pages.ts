// Per-page watermark check (pdftotext does not extract the diagonal watermark run).
// Usage: npx tsx watermark-pages.ts <pdf>  → JSON array: per page, whether the run is drawn.
import { readFileSync } from "node:fs"
import { pdfPageContents } from "../../../../../lib/pdf/__tests__/pdf-test-utils"
import { SYNTHETIC_DEMO_WATERMARK } from "../../../../../lib/asset-finance/documents/pdf-layout"
const CP = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ"
const winAnsi = (h: string) => [...Buffer.from(h, "hex")].map((b) => (b >= 0x80 && b <= 0x9f ? CP[b - 0x80] : String.fromCharCode(b))).join("")
;(async () => {
  const pages = await pdfPageContents(readFileSync(process.argv[2]))
  console.log(JSON.stringify(pages.map((c: string) => [...c.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].some((m) => winAnsi(m[1]) === SYNTHETIC_DEMO_WATERMARK))))
})()

import { PDFDocument } from "pdf-lib"
import { describe, expect, it } from "vitest"
import { createSigningPacketPdf } from "./signingPacket"

async function pdfWithPages(sizes: Array<[number, number]>) {
  const document = await PDFDocument.create()
  for (const size of sizes) document.addPage(size)
  return document.save()
}

describe("createSigningPacketPdf", () => {
  it("keeps every PASQ page first and every agreement page after it", async () => {
    const bytes = await createSigningPacketPdf(
      await pdfWithPages([[200, 300], [201, 301]]),
      await pdfWithPages([[400, 500], [401, 501], [402, 502]]),
    )
    const packet = await PDFDocument.load(bytes)

    expect(packet.getPageCount()).toBe(5)
    expect(packet.getPages().map((page) => [page.getWidth(), page.getHeight()]))
      .toEqual([
        [200, 300],
        [201, 301],
        [400, 500],
        [401, 501],
        [402, 502],
      ])
  })
})

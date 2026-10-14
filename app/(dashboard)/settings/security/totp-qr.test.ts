import { PNG } from "pngjs"
import jsQR from "jsqr"
import { afterEach, describe, expect, it, vi } from "vitest"
import { otpauthQrDataUrl } from "./totp-qr"

const URI = "otpauth://totp/Acme:officer%40lender.example?secret=JBSWY3DPEHPK3PXP&issuer=Acme"

afterEach(() => vi.restoreAllMocks())

describe("otpauthQrDataUrl", () => {
  it("returns a local PNG data URL, not a remote URL", async () => {
    const url = await otpauthQrDataUrl(URI)
    expect(url.startsWith("data:image/png;base64,")).toBe(true)
    expect(url).not.toMatch(/https?:\/\//)
  })

  it("encodes exactly the otpauth URI: the image decodes back to it", async () => {
    const url = await otpauthQrDataUrl(URI)
    const png = PNG.sync.read(Buffer.from(url.split(",")[1], "base64"))
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)
    expect(decoded?.data).toBe(URI)
  })

  it("makes no network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    await otpauthQrDataUrl(URI)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

import { PNG } from "pngjs"
import jsQR from "jsqr"
import { afterEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { buildTotpSetup, otpauthQrDataUrl } from "./totp-qr"
import { TotpQrImage } from "./TotpQrImage"

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

describe("QR failure fallback", () => {
  const data = { secret: "JBSWY3DPEHPK3PXP", otpauth: URI }

  it("keeps the secret and otpauth when QR generation throws", async () => {
    const setup = await buildTotpSetup(data, () => Promise.reject(new Error("boom")))
    expect(setup).toEqual({ ...data, qrUrl: null })
  })

  it("shows the manual-entry note instead of an image when there is no QR", () => {
    const html = renderToStaticMarkup(<TotpQrImage qrUrl={null} />)
    expect(html).toContain("QR unavailable — enter the key manually")
    expect(html).not.toContain("<img")
  })

  it("passes the otpauth URI to the generator", async () => {
    const toQr = vi.fn().mockResolvedValue("data:image/png;base64,AAAA")
    const setup = await buildTotpSetup(data, toQr)
    expect(toQr).toHaveBeenCalledWith(URI)
    expect(setup.qrUrl).toBe("data:image/png;base64,AAAA")
  })
})

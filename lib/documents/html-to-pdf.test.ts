import { describe, it, expect, vi, beforeEach } from "vitest"

const { setContent, waitForNetworkIdle, pdf, newPage, close, launch } = vi.hoisted(() => ({
  setContent: vi.fn(),
  waitForNetworkIdle: vi.fn(),
  pdf: vi.fn(),
  newPage: vi.fn(),
  close: vi.fn(),
  launch: vi.fn(),
}))

vi.mock("puppeteer", () => ({
  default: { launch },
}))

import { htmlToPdf } from "./html-to-pdf"

beforeEach(() => {
  vi.clearAllMocks()
  newPage.mockResolvedValue({ setContent, waitForNetworkIdle, pdf })
  launch.mockResolvedValue({ newPage, close })
})

describe("htmlToPdf", () => {
  it("launches chromium, renders the given HTML and returns the PDF buffer", async () => {
    const fakePdf = Buffer.from("%PDF-1.4 fake")
    pdf.mockResolvedValue(fakePdf)

    const result = await htmlToPdf("<h1>Hi</h1>")

    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      }),
    )
    expect(newPage).toHaveBeenCalledTimes(1)
    expect(setContent).toHaveBeenCalledWith("<h1>Hi</h1>", { waitUntil: "load" })
    expect(waitForNetworkIdle).toHaveBeenCalledWith({ idleTime: 500, concurrency: 0 })
    expect(waitForNetworkIdle.mock.invocationCallOrder[0]).toBeGreaterThan(setContent.mock.invocationCallOrder[0])
    expect(pdf.mock.invocationCallOrder[0]).toBeGreaterThan(waitForNetworkIdle.mock.invocationCallOrder[0])
    expect(pdf).toHaveBeenCalledWith(
      expect.objectContaining({ format: "A4", printBackground: true }),
    )
    expect(result).toBeInstanceOf(Buffer)
    expect(result.equals(fakePdf)).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("closes the browser even when rendering throws, and propagates the error", async () => {
    const boom = new Error("render failed")
    pdf.mockRejectedValue(boom)

    await expect(htmlToPdf("<p>x</p>")).rejects.toThrow(boom)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

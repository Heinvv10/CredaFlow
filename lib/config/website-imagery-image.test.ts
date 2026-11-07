import { describe, expect, it } from "vitest"
import { IMAGERY_MAX_BYTES } from "./website-imagery-schema"
import { inspectImage } from "./website-imagery-image"
import { makeJpeg, makeWebp } from "./__fixtures__/images"
import { makePng } from "./__fixtures__/png"

describe("inspectImage", () => {
  it("reads a PNG, a baseline and a progressive JPEG, and WebP in all three layouts, by content", () => {
    expect(inspectImage(makePng(320, 200))).toEqual({ ok: true, format: "png", mime: "image/png", width: 320, height: 200 })
    expect(inspectImage(makeJpeg(1600, 900))).toEqual({ ok: true, format: "jpeg", mime: "image/jpeg", width: 1600, height: 900 })
    expect(inspectImage(makeJpeg(640, 480, { sof: 0xc2 }))).toMatchObject({ ok: true, format: "jpeg", width: 640, height: 480 })
    expect(inspectImage(makeWebp(1200, 800))).toEqual({ ok: true, format: "webp", mime: "image/webp", width: 1200, height: 800 })
    expect(inspectImage(makeWebp(1201, 801, { kind: "lossless" }))).toMatchObject({ ok: true, format: "webp", width: 1201, height: 801 })
    expect(inspectImage(makeWebp(2400, 1600, { kind: "extended" }))).toMatchObject({ ok: true, format: "webp", width: 2400, height: 1600 })
  })

  it.each([
    ["a GIF", Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1")],
    ["an SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')],
    ["an HTML page", Buffer.from("<!doctype html><script>alert(1)</script>")],
    ["a PDF", Buffer.from("%PDF-1.7\n")],
    ["an empty file", Buffer.alloc(0)],
  ])("refuses %s", (_what, bytes) => {
    expect(inspectImage(bytes)).toEqual({ ok: false, error: "The image must be a JPEG, PNG or WebP file." })
  })

  it("refuses a file by its bytes even when it would be named .jpg", () => {
    expect(inspectImage(Buffer.from("<html>not a jpg</html>"))).toMatchObject({ ok: false })
  })

  it("refuses a file over 3 MB", () => {
    const big = makeJpeg(800, 600, { padding: IMAGERY_MAX_BYTES })
    expect(big.length).toBeGreaterThan(IMAGERY_MAX_BYTES)
    expect(inspectImage(big)).toEqual({ ok: false, error: "The image must be at most 3 MB." })
  })

  it("accepts a file just under 3 MB", () => {
    const edge = makeJpeg(800, 600, { padding: IMAGERY_MAX_BYTES - 200 })
    expect(edge.length).toBeLessThanOrEqual(IMAGERY_MAX_BYTES)
    expect(inspectImage(edge)).toMatchObject({ ok: true })
  })

  it.each([
    ["PNG", makePng(6001, 100)],
    ["JPEG", makeJpeg(100, 6001)],
    ["WebP", makeWebp(6001, 100)],
  ])("refuses a %s over 6000 px without decoding it", (_what, bytes) => {
    expect(inspectImage(bytes)).toEqual({ ok: false, error: "The image must be at most 6000×6000 pixels." })
  })

  it("refuses an animated WebP", () => {
    expect(inspectImage(makeWebp(400, 300, { kind: "extended", animated: true }))).toMatchObject({ ok: false, error: expect.stringMatching(/Animated/) })
  })

  it.each([
    ["a truncated PNG", makePng(10, 10).subarray(0, 20)],
    ["a JPEG with no frame header", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02])],
    ["a JPEG cut off mid-header", makeJpeg(10, 10).subarray(0, 24)],
    ["a WebP with an unknown chunk", Buffer.concat([Buffer.from("RIFF\x20\x00\x00\x00WEBPJUNK", "latin1"), Buffer.alloc(32)])],
    ["a zero-sized JPEG", makeJpeg(0, 0)],
  ])("refuses %s as unreadable", (_what, bytes) => {
    expect(inspectImage(bytes)).toMatchObject({ ok: false, error: expect.stringMatching(/could not be read/) })
  })
})

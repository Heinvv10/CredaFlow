import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { extractDocumentData } from "./vlm-extract"

// pdftoppm is stubbed at the process seam because the degenerate render cannot
// be provoked through a fixture any more: -scale-to bounds the raster by output
// pixels, and a page declaring itself 70x A4 — the case that produced a 1x1
// JPEG with exit code 0 — now renders correctly. The failure mode is still
// real (poppler prints "Bogus memory allocation size", writes a valid 1x1 JPEG
// and returns 0), so the guard against it must stay wired in. Nothing else in
// the suite fails if the call site is deleted.
const execFileSync = vi.fn()
vi.mock("child_process", () => ({ execFileSync: (...args: unknown[]) => execFileSync(...args) }))

const ONE_BY_ONE_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
)

describe("a render pdftoppm refused but reported as success", () => {
  const originalFetch = globalThis.fetch
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubEnv("VLM_API_URL", "http://vlm.test:8100")
    vi.stubEnv("VLM_MODEL", "test-model")
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "{}" } }],
    }), { status: 200 }))
    globalThis.fetch = fetchMock as typeof fetch

    // extractDocumentData makes TWO calls through this seam, and they must be
    // answered differently. Answering both the same way is what made this test
    // vacuous: pdfinfo got an empty string, cropBoxPt threw "could not read the
    // page box", and the run failed BEFORE the render guard was reached — so
    // the test passed with the guard deleted, while writing a stray
    // "undefined.jpg" into the repo root from args[4] on the pdfinfo call,
    // whose argv is one element shorter.
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      const script = args[1] ?? ""

      // 1. cropBoxPt's geometry probe. A real A4 page, so the render guard has
      //    a genuine expectation to compare against.
      if (script.includes("pdfinfo")) {
        return "CropBox:        0.00     0.00   595.00   842.00\nPage rot:       0\n"
      }

      // 2. The render. Exactly what poppler does on an allocation it refuses:
      //    write a valid but empty 1x1 page to the requested path, exit 0.
      if (script.includes("pdftoppm")) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("fs").writeFileSync(`${args[4]}.jpg`, ONE_BY_ONE_JPEG)
        return Buffer.alloc(0)
      }

      // A third call would otherwise be answered with silence and fail
      // somewhere unrelated, which is how this test went wrong the first time.
      throw new Error(`unstubbed execFileSync call: ${script}`)
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    globalThis.fetch = originalFetch
    fetchMock.mockReset()
    execFileSync.mockReset()
  })

  it("refuses the document instead of asking the model to read a 1x1 pixel", async () => {

    const result = await extractDocumentData({
      fileBuffer: Buffer.from("%PDF-1.4 stub, the render is mocked"),
      mimeType: "application/pdf",
      docType: "PAYSLIP",
    })

    // Precondition: the stub really did stand in for the render.
    expect(execFileSync).toHaveBeenCalled()

    expect(result.ok).toBe(false)
    // Assert the SPECIFIC refusal. "PDF conversion failed" is the wrapper on
    // every failure in this path, including the geometry probe throwing, so
    // matching only that cannot tell the render guard from anything else —
    // which is precisely how this test passed with the guard disabled.
    expect(result.error).toContain("render produced 1x1px")
    // The whole point. A 1x1 white pixel sent to the model returns an answer,
    // and that answer would be written to the client's income.
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

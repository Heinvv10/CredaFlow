import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  RENDER_DPI,
  MAX_RENDER_PIXELS,
  isFullPageRender,
  jpegSizePx,
  renderTargetPx,
  applyPayslipPostProcessing,
  applyBankProductPostProcessing,
  extractDocumentData,
  payslipPrompt,
  type ExtractedFields,
} from "./vlm-extract"

function asFields(values: Record<string, number>): ExtractedFields {
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, { value: v, validated: true }]),
  )
}

type VlmRequestBody = {
  model: string
  messages: Array<{
    role: string
    content: Array<{ type: string; text?: string; image_url?: { url: string } }>
  }>
}

function vlmResponse(payload: Record<string, unknown>) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(payload) } }],
  }), { status: 200, headers: { "content-type": "application/json" } })
}

describe("extractDocumentData face-match request shape", () => {
  const originalFetch = globalThis.fetch
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubEnv("VLM_API_URL", "http://vlm.test:8100")
    vi.stubEnv("VLM_MODEL", "test-model")
    fetchMock.mockResolvedValue(vlmResponse({ faceDetected: true }))
    globalThis.fetch = fetchMock as typeof fetch
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    globalThis.fetch = originalFetch
    fetchMock.mockReset()
  })

  function sentBody(): VlmRequestBody {
    return JSON.parse(fetchMock.mock.calls[0][1].body as string) as VlmRequestBody
  }

  it("sends BOTH images — selfie first, ID document second — with the face-match prompt", async () => {
    await extractDocumentData({
      fileBuffer: Buffer.from("selfie-bytes"),
      mimeType: "image/jpeg",
      docType: "SELFIE",
      referenceImage: { fileBuffer: Buffer.from("id-bytes"), mimeType: "image/png" },
    })

    const content = sentBody().messages[0].content
    const images = content.filter((part) => part.type === "image_url")
    expect(images).toHaveLength(2)
    expect(images[0].image_url?.url).toBe(
      `data:image/jpeg;base64,${Buffer.from("selfie-bytes").toString("base64")}`,
    )
    expect(images[1].image_url?.url).toBe(
      `data:image/png;base64,${Buffer.from("id-bytes").toString("base64")}`,
    )
    const text = content.find((part) => part.type === "text")?.text ?? ""
    // The face-match prompt is what makes the VLM the biometric provider —
    // it must demand the verdict fields the KYC gate consumes.
    expect(text).toContain("faceMatch")
    expect(text).toContain("matchConfidence")
    expect(text).toContain("livenessConfidence")
    expect(text).toContain("idPhotoFaceDetected")
    // The separate judgements the code-side gate in lib/kyc/vlm-face-match
    // requires; a prompt that stops asking for one fails every attempt closed.
    expect(text).toContain("idPhotoKind")
    expect(text).toContain("silhouette_placeholder")
    expect(text).toContain("idPhotoIsRealPhotograph")
    expect(text).toContain("selfieIsRealPhotograph")
    expect(text).toContain("samePerson")
  })

  it("keeps the single-image liveness prompt when no reference image is given", async () => {
    await extractDocumentData({
      fileBuffer: Buffer.from("selfie-bytes"),
      mimeType: "image/jpeg",
      docType: "SELFIE",
    })

    const content = sentBody().messages[0].content
    expect(content.filter((part) => part.type === "image_url")).toHaveLength(1)
    const text = content.find((part) => part.type === "text")?.text ?? ""
    expect(text).not.toContain("faceMatch")
    expect(text).toContain("liveness verification")
  })

  it("maps the verdict fields through to extracted data", async () => {
    fetchMock.mockResolvedValueOnce(vlmResponse({
      faceDetected: true,
      facesCount: 1,
      quality: "good",
      isLive: true,
      livenessConfidence: 0.97,
      idPhotoFaceDetected: true,
      faceMatch: false,
      matchConfidence: 0.1,
    }))

    const result = await extractDocumentData({
      fileBuffer: Buffer.from("selfie-bytes"),
      mimeType: "image/jpeg",
      docType: "SELFIE",
      referenceImage: { fileBuffer: Buffer.from("id-bytes"), mimeType: "image/jpeg" },
    })

    expect(result.ok).toBe(true)
    // faceMatch:false must survive mapping — a falsy verdict that gets
    // dropped would silently erase a NO-MATCH result.
    expect(result.data?.faceMatch).toEqual(expect.objectContaining({ value: false }))
    expect(result.data?.matchConfidence).toEqual(expect.objectContaining({ value: 0.1 }))
    expect(result.data?.livenessConfidence).toEqual(expect.objectContaining({ value: 0.97 }))
    expect(result.data?.idPhotoFaceDetected).toEqual(expect.objectContaining({ value: true }))
  })

  // The VLM reports no per-field confidence, so any number in that position is
  // invented. One used to be: a hardcoded 0.95 on EVERY field of EVERY document
  // type, which the staff document panel rendered as "(95%)" — a fabricated
  // certainty shown to the people deciding whether to lend. On a selfie it sat
  // beside `matchConfidence`, annotating the one genuine model confidence on
  // the page with a fake one.
  it("attaches no confidence to any extracted field", async () => {
    vi.mocked(globalThis.fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue(vlmResponse({
        idNumber: "9001015009087",
        surname: "Customer",
        firstName: "Synthetic",
        dateOfBirth: "1990-01-01",
        gender: "Male",
      }))

    const result = await extractDocumentData({
      fileBuffer: Buffer.from("id-bytes"),
      mimeType: "image/jpeg",
      docType: "ID_COPY",
    })

    expect(result.ok).toBe(true)
    const fields = Object.entries(result.data ?? {})
    expect(fields.length).toBeGreaterThan(0)
    for (const [name, field] of fields) {
      expect(
        Object.prototype.hasOwnProperty.call(field, "confidence"),
        `field "${name}" carries a confidence the model never reported`,
      ).toBe(false)
    }
  })
})

describe("PDF conversion temp-file hygiene", () => {
  const originalFetch = globalThis.fetch
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubEnv("VLM_API_URL", "http://vlm.test:8100")
    vi.stubEnv("VLM_MODEL", "test-model")
    fetchMock.mockResolvedValue(vlmResponse({}))
    globalThis.fetch = fetchMock as typeof fetch
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    globalThis.fetch = originalFetch
    fetchMock.mockReset()
  })

  async function strandedTempFiles(): Promise<string[]> {
    const { readdirSync } = await import("node:fs")
    // Prefix must track the real scratch names in vlm-extract.ts (now private
    // vlm-* DIRECTORIES, formerly vlm-in-* files). A stale prefix here matches
    // nothing and the test passes without observing anything.
    return readdirSync("/tmp").filter((f) => f.startsWith("vlm-")).sort()
  }

  // The document written to /tmp is the client's bank statement or payslip in
  // plaintext. Cleanup used to run only after a successful convert, so every
  // failure left one behind.
  it("removes the client's document from /tmp when conversion FAILS", async () => {
    const before = await strandedTempFiles()

    const result = await extractDocumentData({
      fileBuffer: Buffer.from("%PDF-1.4 truncated, pdftoppm cannot convert this"),
      mimeType: "application/pdf",
      docType: "BANK_STATEMENT",
    })

    // Precondition: this input really must fail, or the test proves nothing.
    expect(result.ok).toBe(false)
    expect(result.error).toContain("PDF conversion failed")
    expect(await strandedTempFiles()).toEqual(before)
  })

  it("still reports the conversion failure to the caller", async () => {
    const result = await extractDocumentData({
      fileBuffer: Buffer.from("%PDF-1.4 truncated"),
      mimeType: "application/pdf",
      docType: "PAYSLIP",
    })

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("PDF conversion failed"),
    })
    // Cleanup must not swallow the failure into a false success.
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("payslip period-column post-processing", () => {
  // Synthetic figures, shaped like a payslip (Jul 2026) that the VLM read
  // wrong: it took Total Earnings and Total Deductions from the
  // YTD column while taking Net Pay (which has no YTD column) from the current
  // period, producing an income 4x the client's actual monthly earnings.
  const CURRENT = { grossIncome: 4012345, netIncome: 2654321, totalDeductions: 1358024 }
  const YTD_CONTAMINATED = { grossIncome: 16049380, netIncome: 2654321, totalDeductions: 5432096 }

  it("names the current-period column and rules out year-to-date figures", () => {
    expect(payslipPrompt()).toMatch(/year.to.date|YTD/i)
    expect(payslipPrompt()).toMatch(/current/i)
  })

  it("accepts a payslip whose gross - deductions equals net", () => {
    const fields = applyPayslipPostProcessing(asFields(CURRENT), "PAYSLIP")

    expect(fields.grossIncome.validated).toBe(true)
    expect(fields.totalDeductions.validated).toBe(true)
    expect(fields._payslipConsistencyWarning).toBeUndefined()
  })

  it("flags the YTD-contaminated read that gross - deductions no longer equals net", () => {
    const fields = applyPayslipPostProcessing(asFields(YTD_CONTAMINATED), "PAYSLIP")

    expect(fields.grossIncome.validated).toBe(false)
    expect(fields.totalDeductions.validated).toBe(false)
    expect(String(fields._payslipConsistencyWarning.value)).toMatch(/year.to.date|YTD/i)
  })

  it("tolerates sub-rand rounding between the three totals", () => {
    const fields = applyPayslipPostProcessing(
      asFields({ ...CURRENT, netIncome: CURRENT.netIncome + 40 }),
      "PAYSLIP",
    )

    expect(fields.grossIncome.validated).toBe(true)
  })

  // The guard bailed out entirely when any one figure failed to parse, leaving
  // all three at their default validated:true. So a VLM returning YTD integers
  // for gross/deductions and a STRING "R26,543.21" for net produced no warning
  // at all, and apply-extraction happily wrote the 4x gross. A figure the code
  // cannot check is not a figure it may vouch for.
  it("refuses to vouch for money fields when one of them will not parse", () => {
    const fields = applyPayslipPostProcessing(
      {
        grossIncome: { value: 16049380,  validated: true },
        totalDeductions: { value: 5432096,  validated: true },
        netIncome: { value: "R26,543.21",  validated: true },
      },
      "PAYSLIP",
    )

    expect(fields.grossIncome.validated).toBe(false)
    expect(fields.totalDeductions.validated).toBe(false)
    expect(String(fields._payslipConsistencyWarning.value)).toMatch(/could not be read as a number/i)
  })

  it.each([
    ["a string", "40123.45"],
    ["an object", { amount: 4012345 }],
    ["an array", [4012345]],
    ["null-ish text", "n/a"],
    ["Infinity", Infinity],
  ])("refuses to vouch when gross is %s", (_label, bad) => {
    const fields = applyPayslipPostProcessing(
      {
        grossIncome: { value: bad,  validated: true },
        totalDeductions: { value: 1358024,  validated: true },
        netIncome: { value: 2654321,  validated: true },
      },
      "PAYSLIP",
    )

    expect(fields.grossIncome.validated).toBe(false)
  })

  // A payslip that genuinely omits a figure is unverified, not wrong — but the
  // fields it DOES carry must still not be vouched for, because the identity
  // that would have checked them never ran.
  it("does not vouch for a partial payslip either", () => {
    const fields = applyPayslipPostProcessing(
      {
        grossIncome: { value: 4012345,  validated: true },
        netIncome: { value: 2654321,  validated: true },
      },
      "PAYSLIP",
    )

    expect(fields.grossIncome.validated).toBe(false)
  })

  it.each([
    ["exactly at tolerance", 100, true],
    ["one cent past tolerance", 101, false],
  ])("treats a drift of %s as validated=%s", (_label, drift, expected) => {
    const fields = applyPayslipPostProcessing(
      asFields({ grossIncome: 4012345, totalDeductions: 1358024, netIncome: 2654321 - drift }),
      "PAYSLIP",
    )

    expect(fields.grossIncome.validated).toBe(expected)
  })

  // Arithmetic alone cannot catch a read where ALL THREE figures come from the
  // YTD column: per-period gross - deductions = net holds every month, so it
  // holds for the running sums too. 160,493.80 - 54,320.96 = 106,172.84
  // reconciles perfectly and is still four months of income. The only way to
  // tell is to make the model name the column it read from.
  it("rejects a perfectly reconciling read the model says came from a YTD column", () => {
    const fields = applyPayslipPostProcessing(
      {
        grossIncome: { value: 16049380,  validated: true },
        totalDeductions: { value: 5432096,  validated: true },
        netIncome: { value: 10617284,  validated: true },
        incomeColumnHeading: { value: "YTD Amount",  validated: true },
      },
      "PAYSLIP",
    )

    // Sanity: this read satisfies the arithmetic identity exactly.
    expect(16049380 - 5432096).toBe(10617284)
    expect(fields.grossIncome.validated).toBe(false)
    expect(String(fields._payslipConsistencyWarning.value)).toMatch(/YTD Amount/)
  })

  // Deny-listing YTD words only catches the wordings someone thought of. An SA
  // payslip may print "Jaar tot datum", "Cum.", "Y/E" or a heading nobody here
  // has seen. Recognise the CURRENT-period headings instead and refuse the rest:
  // an unrecognised heading is an unverified one, and this figure decides a loan.
  it.each([
    ["YTD"],
    ["YTD Amount"],
    ["Year to Date"],
    ["year-to-date"],
    ["Cumulative"],
    ["Y.T.D."],
    ["Jaar tot datum"],
    ["Cum."],
    ["Y/E"],
    ["Tax Year Total"],
    ["FYTD"],
    ["Annual"],
    ["something nobody anticipated"],
  ])("refuses %s — it is not a recognised current-period heading", (heading) => {
    const fields = applyPayslipPostProcessing(
      {
        ...asFields(CURRENT),
        incomeColumnHeading: { value: heading,  validated: true },
      },
      "PAYSLIP",
    )

    expect(fields.grossIncome.validated).toBe(false)
  })

  it.each([
    ["Current"],
    ["This Period"],
    ["Amount"],
    ["Month"],
    ["Current Period"],
    ["Huidige"],
    ["Bedrag"],
    ["This Month"],
  ])("accepts %s as a current-period heading", (heading) => {
    const fields = applyPayslipPostProcessing(
      {
        ...asFields(CURRENT),
        incomeColumnHeading: { value: heading,  validated: true },
      },
      "PAYSLIP",
    )

    expect(fields.grossIncome.validated).toBe(true)
    expect(fields._payslipConsistencyWarning).toBeUndefined()
  })

  // An older extraction has no heading at all. It must not be silently vouched
  // for by a check that never ran, but it also has arithmetic standing behind
  // it, so the arithmetic verdict is what applies.
  it("still applies the arithmetic check when the model reports no column", () => {
    expect(applyPayslipPostProcessing(asFields(CURRENT), "PAYSLIP").grossIncome.validated).toBe(true)
    expect(
      applyPayslipPostProcessing(asFields(YTD_CONTAMINATED), "PAYSLIP").grossIncome.validated,
    ).toBe(false)
  })

  // A payslip with a single amount column has no heading to report, and an
  // extraction predating this field has no heading either. Neither is evidence
  // of contamination, so both fall back to the arithmetic check.
  it.each([
    ["an empty heading (single-column payslip)", ""],
    ["a whitespace-only heading", "   "],
  ])("falls back to arithmetic for %s", (_label, heading) => {
    const fields = applyPayslipPostProcessing(
      { ...asFields(CURRENT), incomeColumnHeading: { value: heading,  validated: true } },
      "PAYSLIP",
    )

    expect(fields.grossIncome.validated).toBe(true)
  })

  it("asks the model which column it read", () => {
    expect(payslipPrompt()).toMatch(/incomeColumnHeading/)
  })

  it("does not touch a non-payslip document", () => {
    const fields = applyPayslipPostProcessing(asFields(YTD_CONTAMINATED), "BANK_STATEMENT")

    expect(fields.grossIncome.validated).toBe(true)
  })
})


describe("the page the model is shown", () => {
  const originalFetch = globalThis.fetch
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubEnv("VLM_API_URL", "http://vlm.test:8100")
    vi.stubEnv("VLM_MODEL", "test-model")
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "{}" } }],
    }), { status: 200 }))
    globalThis.fetch = fetchMock as typeof fetch
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    globalThis.fetch = originalFetch
    fetchMock.mockReset()
  })

  // A PDF viewer displays the CropBox; pdftoppm renders the MediaBox unless
  // told otherwise. Without -cropbox the model is shown content between the
  // two — figures a staff member comparing the extraction against the document
  // in any normal viewer would never see. payslip-outside-cropbox.pdf is
  // MediaBox 400x300pt with CropBox 400x150pt and text hidden below the crop.
  it("is the CropBox, not the whole MediaBox", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")

    await extractDocumentData({
      fileBuffer: readFileSync(join(import.meta.dirname, "__fixtures__", "payslip-outside-cropbox.pdf")),
      mimeType: "application/pdf",
      docType: "PAYSLIP",
    })

    const content = (JSON.parse(fetchMock.mock.calls[0][1].body as string) as VlmRequestBody)
      .messages[0].content
    const dataUrl = content.find((part) => part.type === "image_url")!.image_url!.url
    const jpeg = Buffer.from(dataUrl.split(",")[1], "base64")

    // JPEG SOF0/SOF2 carries height then width, big-endian. Every marker before
    // the frame header has a 2-byte length, and entropy-coded data (the only
    // place length-less RST markers appear) always follows it.
    let i = 2
    let height = 0
    let width = 0
    while (i < jpeg.length - 9) {
      if (jpeg[i] !== 0xff) { i++; continue }
      const marker = jpeg[i + 1]
      if (marker === 0xc0 || marker === 0xc2) {
        height = jpeg.readUInt16BE(i + 5)
        width = jpeg.readUInt16BE(i + 7)
        break
      }
      i += 2 + jpeg.readUInt16BE(i + 2)
    }

    // Asserted as an ASPECT RATIO, which is what actually separates the two
    // boxes and is the only form that survives a change of scale. The fixture
    // is MediaBox 400x300 (ratio 1.33) and CropBox 400x150 (ratio 2.67); a
    // render of the wrong box is off by a factor of two, far outside this band.
    // A pixel height derived from dpi was the earlier form, and it stopped
    // holding once the raster was bounded by output pixels rather than dpi —
    // the assertion would have failed on a render that is entirely correct.
    expect(width / height).toBeGreaterThan(400 / 150 * 0.9)
    expect(width / height).toBeLessThan(400 / 150 * 1.1)
  })

  // Nothing validates a declared page box. ImageMagick writes the pixel count
  // as the page size, so a 600dpi A4 scan run through it declares a page of
  // 4960x7016 POINTS. Sized from that box, the raster needs over 2GB and the
  // render dies inside MAX_RENDER_MEMORY_KB ("Bogus memory allocation size"),
  // failing extraction on a document that is perfectly legible. Verified
  // against this fixture: -r 400 fails, -scale-to renders it 3307x4677.
  it("renders a page that declares itself 70x A4", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")

    await extractDocumentData({
      fileBuffer: readFileSync(join(import.meta.dirname, "__fixtures__", "payslip-oversized-pagebox.pdf")),
      mimeType: "application/pdf",
      docType: "PAYSLIP",
    })

    // Asserting only that a request was made is NOT enough, and this test was
    // written that way first: at -r 400 pdftoppm exits 0 having written a 1x1
    // JPEG, so the request is made, an image part is present, and the weak
    // assertion passes on a page that never rendered. The size of what the
    // model was actually shown is the thing under test.
    expect(fetchMock).toHaveBeenCalled()
    const parts = (JSON.parse(fetchMock.mock.calls[0][1].body as string) as VlmRequestBody)
      .messages[0].content
    const jpeg = Buffer.from(
      parts.find((part) => part.type === "image_url")!.image_url!.url.split(",")[1],
      "base64",
    )
    // 4960x7016pt at 400dpi would be 1074 Mpx, so this page is budget-capped —
    // and still rendered far larger than the 15.5 Mpx a long-edge fit gave it.
    expect(jpegSizePx(jpeg)).toEqual(renderTargetPx(4960, 7016))
    expect(jpegSizePx(jpeg).widthPx * jpegSizePx(jpeg).heightPx).toBeLessThanOrEqual(MAX_RENDER_PIXELS)
  })
})

// The one thing the suite can pin about render resolution. Accuracy itself
// needs a live model and real payslips, so it cannot live here — but the
// threshold it established can.
describe("render resolution", () => {
  // The geometry tests compare the render against RENDER_MAX_EDGE_PX, so they
  // pass for ANY value of it — a wrong constant is invisible to them. This is
  // the one assertion that does not derive its expectation from the thing it
  // checks: the raster must never be SMALLER than the -r RENDER_DPI raster the
  // accuracy figures were measured on. 841.89pt at 400dpi is 4677.2px, so
  // rounding down loses a pixel and re-rounds the measurement's basis.
  it("renders an A4 page at exactly the resolution accuracy was measured at", () => {
    // A4 at RENDER_DPI is well inside the budget, so it must get true DPI —
    // not a reduced-but-plausible number. Does not derive from the constant it
    // checks: the expectation is the dpi arithmetic itself.
    const { widthPx, heightPx } = renderTargetPx(595.276, 841.89)
    expect(heightPx).toBe(Math.ceil((841.89 / 72) * RENDER_DPI))
    expect(widthPx).toBe(Math.ceil((595.276 / 72) * RENDER_DPI))
  })

  // Fitting only the LONG edge lets the
  // SHORT edge collapse on an elongated page, and the short edge is where the
  // columns are. A 600x4000pt page — an ordinary "share as PDF" export from a
  // phone banking app — would render 702px wide, an effective 84dpi.
  it("holds the short edge above the accuracy floor on an elongated page", () => {
    const { widthPx } = renderTargetPx(600, 4000)
    const effectiveDpi = widthPx / (600 / 72)
    expect(effectiveDpi).toBeGreaterThanOrEqual(300)
  })

  it.each([
    ["US Letter", 612, 792],
    ["Legal", 612, 1008],
    ["A3", 841.89, 1190.55],
  ])("keeps %s above the accuracy floor across the page", (_label, widthPt, heightPt) => {
    const { widthPx } = renderTargetPx(widthPt, heightPt)
    expect(widthPx / (widthPt / 72)).toBeGreaterThanOrEqual(300)
  })

  it("stays at or above the resolution where column reads stopped failing", () => {
    // At low resolution the model reads the year-to-date column instead of
    // the current month. At 300 and above it does not. Below 300
    // the model can see the digits perfectly and still cannot tell which column
    // they sit under, which is a silent wrong answer about someone's income.
    expect(RENDER_DPI).toBeGreaterThanOrEqual(300)
  })
})

// pdftoppm can fail AND exit 0: on a page it cannot allocate it writes a valid
// 1x1 JPEG and returns success. Measured on a page declaring itself 4960x7016pt:
// 631 bytes, 1x1 px, rc=0. Nothing downstream distinguishes that from a payslip,
// so the model would be asked to read income off a single white pixel and
// whatever it answered would be stored as fact.
describe("a render that pdftoppm refused but reported as success", () => {
  function jpegOf(width: number, height: number): Buffer {
    // Padded past the frame header: the scan follows it in any real JPEG, and
    // the parser needs that headroom before it will read the segment.
    const b = Buffer.alloc(32)
    b.writeUInt16BE(0xffd8, 0)   // SOI
    b.writeUInt16BE(0xffc0, 2)   // SOF0
    b.writeUInt16BE(8, 4)        // segment length
    b.writeUInt8(8, 6)           // sample precision
    b.writeUInt16BE(height, 7)
    b.writeUInt16BE(width, 9)
    return b
  }

  it("reads the page size out of the frame header", () => {
    expect(jpegSizePx(jpegOf(3307, 4677))).toEqual({ widthPx: 3307, heightPx: 4677 })
    expect(jpegSizePx(jpegOf(1, 1))).toEqual({ widthPx: 1, heightPx: 1 })
    expect(jpegSizePx(Buffer.from("not a jpeg at all"))).toEqual({ widthPx: 0, heightPx: 0 })
  })

  it("rejects the 1x1 stub and accepts a full page", () => {
    const target = renderTargetPx(595, 842)
    expect(isFullPageRender(jpegOf(1, 1), target)).toBe(false)
    expect(isFullPageRender(jpegOf(target.widthPx, target.heightPx), target)).toBe(true)
    // A render that stopped part-way is just as unusable as the 1x1 one.
    expect(isFullPageRender(jpegOf(800, 1131), target)).toBe(false)
    // And one that is full LENGTH but collapsed across the short edge — the
    // shape a long-edge-only fit produced on an elongated page.
    expect(isFullPageRender(jpegOf(702, target.heightPx), target)).toBe(false)
  })
})

// The guard's worst failure is not missing a bad render — it is REFUSING a good
// one, which would block a real client's document. It rejects anything under
// 90% of RENDER_MAX_EDGE_PX, which is only safe because -scale-to fits the long
// edge to exactly that many pixels for ANY page size, upscaling a small page as
// readily as it shrinks a large one. Measured across 8 geometries from 72x72pt
// to A0; three are pinned here, including the two extremes.
describe("page geometries the guard must not refuse", () => {
  const originalFetch = globalThis.fetch
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubEnv("VLM_API_URL", "http://vlm.test:8100")
    vi.stubEnv("VLM_MODEL", "test-model")
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "{}" } }],
    }), { status: 200 }))
    globalThis.fetch = fetchMock as typeof fetch
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    globalThis.fetch = originalFetch
    fetchMock.mockReset()
  })

  function onePagePdf(widthPt: number, heightPt: number, rotate = 0, titleBytes = 0): Buffer {
    const content = Buffer.from(`BT /F1 12 Tf 20 ${Math.floor(heightPt / 2)} Td (Payslip 40123.45) Tj ET`)
    const objs = [
      Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
      Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
      Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}]${rotate ? ` /Rotate ${rotate}` : ""} /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`),
      Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]),
      Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
      Buffer.from(`<< /Title (${"A".repeat(titleBytes)}) >>`),
    ]
    let out = Buffer.from("%PDF-1.4\n")
    const offsets: number[] = []
    objs.forEach((o, i) => {
      offsets.push(out.length)
      out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from("\nendobj\n")])
    })
    const xref = out.length
    out = Buffer.concat([out, Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`)])
    for (const o of offsets) out = Buffer.concat([out, Buffer.from(`${String(o).padStart(10, "0")} 00000 n \n`)])
    return Buffer.concat([out, Buffer.from(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${objs.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`)])
  }


  // pdfinfo echoes the Info dictionary BEFORE it reaches CropBox, which
  // pdftoppm never did — it writes an image to a file and surfaces no metadata.
  // So an oversized metadata field alone exhausts maxBuffer and fails a
  // document whose geometry is perfectly ordinary. OCR tools do stuff extracted
  // text into these fields. 1.5MB beats the old 1MB cap.
  it("reads the page box past a document stuffed with metadata", async () => {
    const result = await extractDocumentData({
      fileBuffer: onePagePdf(595, 842, 0, 1_500_000),
      mimeType: "application/pdf",
      docType: "PAYSLIP",
    })

    expect(result.error ?? "").not.toContain("PDF conversion failed")
    expect(fetchMock).toHaveBeenCalled()
    const parts = (JSON.parse(fetchMock.mock.calls[0][1].body as string) as VlmRequestBody)
      .messages[0].content
    const jpeg = Buffer.from(
      parts.find((part) => part.type === "image_url")!.image_url!.url.split(",")[1],
      "base64",
    )
    expect(jpegSizePx(jpeg)).toEqual(renderTargetPx(595, 842))
  })
  it.each([
    ["a receipt slip", 200, 100, 0],
    ["A4 landscape", 842, 595, 0],
    ["an A0 poster", 2384, 3370, 0],
    // A phone or office scanner routinely emits an upright page with /Rotate
    // set rather than swapped MediaBox dimensions.
    ["an A4 page rotated 90 degrees", 595, 842, 90],
  ])("renders %s to the full page size", async (_label, widthPt, heightPt, rotate) => {
    const result = await extractDocumentData({
      fileBuffer: onePagePdf(widthPt, heightPt, rotate),
      mimeType: "application/pdf",
      docType: "PAYSLIP",
    })

    // Not result.ok — the stubbed VLM returns an empty body, which fails to
    // parse for reasons that have nothing to do with the render. The guard
    // throwing surfaces specifically as a conversion failure, and the page the
    // model was actually shown is the thing under test.
    expect(result.error ?? "").not.toContain("PDF conversion failed")
    expect(fetchMock).toHaveBeenCalled()
    const parts = (JSON.parse(fetchMock.mock.calls[0][1].body as string) as VlmRequestBody)
      .messages[0].content
    const jpeg = Buffer.from(
      parts.find((part) => part.type === "image_url")!.image_url!.url.split(",")[1],
      "base64",
    )
    // Exact, on both axes: the render must be the page that was asked for.
    const expected = renderTargetPx(rotate % 180 === 90 ? heightPt : widthPt,
                                    rotate % 180 === 90 ? widthPt : heightPt)
    expect(jpegSizePx(jpeg)).toEqual(expected)
  })
})

describe("bank-statement product-name post-processing", () => {
  const statement = (accountType: string, printed: string | null) => ({
    bankName: { value: "ABSA", validated: true },
    accountType: { value: accountType, validated: true },
    ...(printed === null
      ? {}
      : { accountTypePrinted: { value: printed, validated: true } }),
  })

  // An ABSA "Flexi Account" statement extracted as CHEQUE would refuse a
  // SAVINGS payout record as a mismatch. Flexi
  // is ABSA's savings product; the printed name is authoritative over a guess.
  it.each([
    ["Flexi Account", "SAVINGS"],
    ["FLEXI SAVINGS ACCOUNT", "SAVINGS"],
    // Standard Bank prints "MYMOACC"; the VLM said CHEQUE, but it is a savings account.
    ["MYMOACC", "SAVINGS"],
    ["MyMo Account", "SAVINGS"],
    ["Easy Account", "CHEQUE"],
    ["PRESTIGEACC", "CHEQUE"],
  ])("binds printed product %s to %s over the model's answer", (printed, want) => {
    const fields = applyBankProductPostProcessing(statement("OTHER", printed), "BANK_STATEMENT")
    expect(fields.accountType.value).toBe(want)
  })

  it("overrides a WRONG guess, not only OTHER", () => {
    const fields = applyBankProductPostProcessing(statement("CHEQUE", "Flexi Account"), "BANK_STATEMENT")
    expect(fields.accountType.value).toBe("SAVINGS")
  })

  it("leaves an unknown product and a missing printed name alone", () => {
    expect(applyBankProductPostProcessing(statement("CHEQUE", "Main Account"), "BANK_STATEMENT").accountType.value).toBe("CHEQUE")
    expect(applyBankProductPostProcessing(statement("OTHER", null), "BANK_STATEMENT").accountType.value).toBe("OTHER")
  })

  it("does nothing for other document types", () => {
    expect(applyBankProductPostProcessing(statement("OTHER", "Flexi Account"), "PAYSLIP").accountType.value).toBe("OTHER")
  })
})

describe("bank-statement product override is wired into extractDocumentData", () => {
  const originalFetch = globalThis.fetch
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubEnv("VLM_API_URL", "http://vlm.test:8100")
    vi.stubEnv("VLM_MODEL", "test-model")
    globalThis.fetch = fetchMock as typeof fetch
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    globalThis.fetch = originalFetch
    fetchMock.mockReset()
  })

  // Calling applyBankProductPostProcessing directly cannot notice the pipeline
  // never invoking it — the first cut of this fix wired it inside the PAYSLIP
  // branch and every unit test still passed.
  it("returns SAVINGS for a statement the model called CHEQUE but printed Flexi Account", async () => {
    fetchMock.mockResolvedValue(vlmResponse({
      bankName: "ABSA", accountNumber: "4000012345",
      accountType: "CHEQUE", accountTypePrinted: "Flexi Account",
    }))
    const result = await extractDocumentData({
      fileBuffer: Buffer.from("statement-bytes"),
      mimeType: "image/jpeg",
      docType: "BANK_STATEMENT",
    })
    expect(result.ok).toBe(true)
    expect(result.data?.accountType.value).toBe("SAVINGS")
    expect(result.data?.accountTypePrinted.value).toBe("Flexi Account")
  })
})

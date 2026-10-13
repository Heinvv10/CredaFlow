/**
 * analyseStatement routing and guards, on real PDFs run through the real
 * poppler tools. Only the vision model's HTTP call is stubbed.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { analyseStatement } from "./analyse"
import { syntheticStatement } from "./fixtures/dataset"
import { buildCapitecStatement, capitecLines } from "./fixtures/synthetic"
import { VLM_MAX_PAGES, VlmUnavailableError } from "./vlm-reader"

const ENV_KEYS = ["VLM_API_URL", "VLM_MODEL"] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  process.env.VLM_API_URL = "http://vlm.test.invalid"
  process.env.VLM_MODEL = "synthetic-model"
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.unstubAllGlobals()
})

const PAGE_JSON = {
  accountHolderName: "T TESTER",
  openingBalance: 100,
  closingBalance: 90,
  transactions: [{ date: "2026-07-02", description: "SYNTH MART", amount: -10, balance: 90 }],
}

function stubVlm() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(PAGE_JSON) } }] }),
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

async function textPdf(pages: string[][], size: [number, number] = [595.28, 841.89]): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Courier)
  for (const lines of pages) {
    const page = doc.addPage(size)
    lines.forEach((l, i) => page.drawText(l, { x: 12, y: size[1] - 30 - i * 10, size: 6, font }))
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }))
}

const FILLER = Array.from({ length: 12 }, (_, i) => `Synthetic filler line number ${i} with enough characters to be text`)

describe("text layout not recognised", () => {
  // Capitec markers and a real text layer, but no "Transaction History" table.
  const capitecNoTable = () => textPdf([["Capitec Bank Limited", "capitecbank.co.za", ...FILLER]])

  it("falls through to the vision reader, which allowVlm:false refuses", async () => {
    const fetchMock = stubVlm()
    await expect(analyseStatement(await capitecNoTable(), "application/pdf", { allowVlm: false })).rejects.toThrow(VlmUnavailableError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("reads with the vision model when allowed and flags TEXT_LAYOUT_UNRECOGNISED", async () => {
    const fetchMock = stubVlm()
    const r = await analyseStatement(await capitecNoTable(), "application/pdf", { allowVlm: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ method: "VLM", status: "READ", bank: "CAPITEC" })
    expect(r.authenticity.signals).toContain("TEXT_LAYOUT_UNRECOGNISED")
    expect(r.authenticity.signals).not.toContain("TEXT_LAYER_ABSENT")
    expect(r.read!.transactions).toHaveLength(1)
  })
})

describe("no text layer", () => {
  it("signals TEXT_LAYER_ABSENT and reads through the vision model", async () => {
    const doc = await PDFDocument.create()
    doc.addPage([595.28, 841.89]).drawRectangle({ x: 50, y: 50, width: 200, height: 200, color: rgb(0.5, 0.5, 0.5) })
    const bytes = Buffer.from(await doc.save({ useObjectStreams: false }))
    const fetchMock = stubVlm()

    const r = await analyseStatement(bytes, "application/pdf", { allowVlm: true })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r.method).toBe("VLM")
    expect(r.bank).toBeNull()
    expect(r.authenticity.signals).toContain("TEXT_LAYER_ABSENT")
  })

  it("does not signal it for a PDF that has text", async () => {
    const fetchMock = stubVlm()
    const r = await analyseStatement(await textPdf([["Unknown Bank Ltd", ...FILLER]]), "application/pdf", { allowVlm: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r.authenticity.signals).not.toContain("TEXT_LAYER_ABSENT")
  })
})

describe("page limit", () => {
  it(`marks a PDF over ${VLM_MAX_PAGES} pages UNSUPPORTED without calling the model`, async () => {
    const pages = Array.from({ length: VLM_MAX_PAGES + 1 }, (_, i) => ["Unknown Bank Ltd", `Page ${i + 1}`, ...FILLER])
    const fetchMock = stubVlm()

    const r = await analyseStatement(await textPdf(pages), "application/pdf", { allowVlm: true })

    expect(r).toMatchObject({ status: "UNSUPPORTED", method: "VLM", bank: null, read: null, balanceCheck: "NOT_APPLICABLE" })
    expect(fetchMock).not.toHaveBeenCalled()
  }, 30_000)
})

describe("implausible period", () => {
  const scenario = { start: "2026-07-01", bank: "CAPITEC" as const }

  it.each([
    ["inverted", { periodStart: "2026-09-30", periodEnd: "2026-07-01" }],
    ["ending in 2099", { periodEnd: "2099-09-30" }],
  ])("drops a period that is %s but still reads the statement", async (_name, override) => {
    const s = { ...syntheticStatement(scenario), ...override }
    const r = await analyseStatement(Buffer.from(await buildCapitecStatement(s)), "application/pdf", { allowVlm: false })
    expect(r.status).toBe("READ")
    expect(r.read!.periodStart).toBeNull()
    expect(r.read!.periodEnd).toBeNull()
    expect(r.read!.transactions.length).toBeGreaterThan(0)
  })

  it("keeps a plausible period", async () => {
    const r = await analyseStatement(Buffer.from(await buildCapitecStatement(syntheticStatement(scenario))), "application/pdf", { allowVlm: false })
    expect(r.read).toMatchObject({ periodStart: "2026-07-01", periodEnd: "2026-09-30" })
  })
})

describe("Capitec reader line-length guard", () => {
  it("skips a line longer than 400 characters instead of reading it as a row", async () => {
    const s = syntheticStatement({ start: "2026-07-01", bank: "CAPITEC" })
    const pages = capitecLines(s).map((p) => [...p])
    const target = pages[0].findIndex((l) => l.includes("SYNTH MART GROCER"))
    expect(target).toBeGreaterThan(0)
    pages[0][target] = pages[0][target].replace("SYNTH MART GROCER", "LONGLINE ROW") + " x".repeat(210)
    const bytes = await textPdf(pages, [4000, 841.89])

    const started = Date.now()
    const r = await analyseStatement(bytes, "application/pdf", { allowVlm: false })

    expect(Date.now() - started).toBeLessThan(10_000)
    expect(r).toMatchObject({ method: "TEXT", status: "READ", bank: "CAPITEC" })
    expect(r.read!.transactions.some((t) => t.description.includes("LONGLINE"))).toBe(false)
    expect(r.read!.transactions).toHaveLength(s.transactions.length - 1)
    expect(r.balanceCheck).toBe("FAIL")
  })
})

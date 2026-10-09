import { readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The document written to disk is the client's payslip or bank statement in the
// clear — income, ID number, employer, account number. Node's writeFileSync
// defaults to 0664 (0644 under Docker's umask), so on a shared /tmp every other
// user and process on the box can read it for the life of the conversion, and
// pdftoppm's output JPEG is created with the same exposure by a tool we do not
// control. Observed at the one moment it is maximally exposed: while the
// external binary is reading it.
//
// child_process is mocked for the whole file, which is why these live apart
// from vlm-extract.test.ts — those tests drive the real pdftotext/pdftoppm.
const observed: Array<{ file: string; dir: string }> = []

vi.mock("child_process", () => ({
  execFileSync: (bin: string, argv: string[]) => {
    const target = argv.find((a) => a.endsWith(".pdf"))
    if (target) {
      observed.push({
        file: (statSync(target).mode & 0o777).toString(8),
        dir: (statSync(dirname(target)).mode & 0o777).toString(8),
      })
    }
    return bin === "pdftotext" ? "" : Buffer.from("")
  },
}))

const { extractDocumentData } = await import("./vlm-extract")

describe("client document confidentiality on disk", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    observed.length = 0
    vi.stubEnv("VLM_API_URL", "http://vlm.test:8100")
    vi.stubEnv("VLM_MODEL", "test-model")
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }),
    ) as typeof fetch
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    globalThis.fetch = originalFetch
  })

  async function convert(docType: string) {
    await extractDocumentData({
      fileBuffer: readFileSync(join(import.meta.dirname, "__fixtures__", "payslip-digital.pdf")),
      mimeType: "application/pdf",
      docType,
    })
    // Without this the assertions below would pass vacuously on an empty array.
    expect(observed.length, "the conversion tool was never invoked").toBeGreaterThan(0)
    return observed
  }

  // Every document type now reaches disk through the same converter, so these
  // are one case parametrised, not two mechanisms. Written as two separate
  // tests they read as broader coverage than they give.
  it.each([["a payslip", "PAYSLIP"], ["an ID copy", "ID_COPY"]])(
    "keeps %s private to this process while it is converted",
    async (_label, docType) => {
      for (const { file, dir } of await convert(docType)) {
        expect(file).toBe("600")
        expect(dir).toBe("700")
      }
    },
  )
})

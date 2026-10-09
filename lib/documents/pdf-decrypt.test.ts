import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  clientPdfPasswordCandidates,
  decryptPdfIfEncrypted,
  isPdf,
} from "./pdf-decrypt"

// RC4-128, user password "1234567890123" — the same scheme and the same
// ID-number-as-password convention observed on the real statements that
// blocked disbursement in production. Regenerate with:
//   pypdf PdfWriter.encrypt(user_password=..., algorithm="RC4-128")
const ENCRYPTED_FIXTURE = path.join(
  __dirname,
  "__fixtures__",
  "encrypted-sample.pdf",
)
const FIXTURE_PASSWORD = "1234567890123"

const encryptedPdf = () => readFileSync(ENCRYPTED_FIXTURE)

function qpdfInstalled(): boolean {
  try {
    execFileSync("qpdf", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

/**
 * A mocked qpdf cannot prove a PDF actually decrypts, so these run the real
 * binary. They are skipped rather than silently passing where it is absent —
 * a green run on a box without qpdf would assert nothing.
 */
const describeWithQpdf = qpdfInstalled() ? describe : describe.skip

describe("isPdf", () => {
  it("recognises a PDF by its magic bytes", () => {
    expect(isPdf(encryptedPdf())).toBe(true)
  })

  it("rejects a non-PDF so qpdf is never invoked on one", () => {
    expect(isPdf(Buffer.from("\x89PNG\r\n\x1a\n"))).toBe(false)
    expect(isPdf(Buffer.from("plain text"))).toBe(false)
    expect(isPdf(Buffer.alloc(0))).toBe(false)
  })
})

describe("clientPdfPasswordCandidates", () => {
  it("offers the client's ID number", () => {
    expect(clientPdfPasswordCandidates({ idNumber: "0212040001084" }))
      .toEqual(["0212040001084"])
  })

  it("offers nothing when the client has no ID number on file", () => {
    expect(clientPdfPasswordCandidates({ idNumber: null })).toEqual([])
    expect(clientPdfPasswordCandidates({})).toEqual([])
  })

  it("ignores a blank ID number rather than attempting an empty password", () => {
    expect(clientPdfPasswordCandidates({ idNumber: "   " })).toEqual([])
  })
})

describeWithQpdf("decryptPdfIfEncrypted", () => {
  it("passes a non-PDF through untouched", async () => {
    const bytes = Buffer.from("\x89PNG\r\n\x1a\n not a pdf")
    const result = await decryptPdfIfEncrypted(bytes, ["1234567890123"])
    expect(result).toEqual({ ok: true, bytes, decrypted: false })
  })

  it("passes an unencrypted PDF through untouched", async () => {
    const clear = execFileSync("qpdf", [
      "--decrypt",
      `--password=${FIXTURE_PASSWORD}`,
      ENCRYPTED_FIXTURE,
      "-",
    ])
    const result = await decryptPdfIfEncrypted(clear, [FIXTURE_PASSWORD])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Untouched, not merely equivalent — an unencrypted upload must be stored
    // byte-for-byte so its contentSha256 binds what the client actually sent.
    expect(result.decrypted).toBe(false)
    expect(result.bytes).toEqual(clear)
  })

  it("decrypts an encrypted PDF with the client's ID number", async () => {
    const result = await decryptPdfIfEncrypted(encryptedPdf(), [FIXTURE_PASSWORD])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decrypted).toBe(true)
    // The point of the fix: the output must open with no password at all.
    expect(await decryptPdfIfEncrypted(result.bytes, [])).toEqual({
      ok: true,
      bytes: result.bytes,
      decrypted: false,
    })
  })

  it("finds the working password among several candidates", async () => {
    const result = await decryptPdfIfEncrypted(encryptedPdf(), [
      "9999999999999",
      FIXTURE_PASSWORD,
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decrypted).toBe(true)
  })

  it("fails closed when no candidate opens the document", async () => {
    const result = await decryptPdfIfEncrypted(encryptedPdf(), ["9999999999999"])
    expect(result).toEqual({ ok: false, reason: "password_unknown" })
  })

  it("fails closed when there are no candidates at all", async () => {
    const result = await decryptPdfIfEncrypted(encryptedPdf(), [])
    expect(result).toEqual({ ok: false, reason: "password_unknown" })
  })

  it("fails closed when every candidate is blank", async () => {
    const result = await decryptPdfIfEncrypted(encryptedPdf(), ["", "  "])
    expect(result).toEqual({ ok: false, reason: "password_unknown" })
  })

  // Uses a private TMPDIR: the previous version listed the shared system temp
  // dir, so a concurrent vitest worker running the real decryptor made it fail
  // intermittently. A flaky POPIA-hygiene assertion gets muted, and then it
  // protects nothing.
  it("leaves no plaintext copy of the document behind in the temp dir", async () => {
    const { mkdtempSync, readdirSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const isolated = mkdtempSync(join(tmpdir(), "cf-test-tmproot-"))
    vi.stubEnv("TMPDIR", isolated)
    try {
      await decryptPdfIfEncrypted(encryptedPdf(), [FIXTURE_PASSWORD])
      await decryptPdfIfEncrypted(encryptedPdf(), ["wrong"])
      expect(readdirSync(isolated)).toEqual([])
    } finally {
      vi.unstubAllEnvs()
      rmSync(isolated, { recursive: true, force: true })
    }
  })
})

describeWithQpdf("decryptPdfIfEncrypted — qpdf exit-code handling", () => {
  const damagedPdf = () => readFileSync(
    path.join(__dirname, "__fixtures__", "encrypted-damaged-sample.pdf"),
  )

  // qpdf exits 3 ("succeeded with warnings") on a file whose xref needs
  // rebuilding — routine for a statement a mail client re-saved — while still
  // writing a valid decrypted PDF. Treating 3 as failure rejected a document
  // that decrypted perfectly, telling staff to check an ID number that was
  // already correct.
  it("accepts a decrypt that succeeded WITH WARNINGS (exit 3)", async () => {
    const result = await decryptPdfIfEncrypted(damagedPdf(), [FIXTURE_PASSWORD])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decrypted).toBe(true)
    expect(isPdf(result.bytes)).toBe(true)
    expect(await decryptPdfIfEncrypted(result.bytes, [])).toEqual({
      ok: true,
      bytes: result.bytes,
      decrypted: false,
    })
  })

  it("still fails closed on a damaged file with the WRONG password", async () => {
    expect(await decryptPdfIfEncrypted(damagedPdf(), ["9999999999999"]))
      .toEqual({ ok: false, reason: "password_unknown" })
  })

  // Owner-password-only files open with no password and already rasterise.
  // Rewriting one would discard the client's original and write an audit row
  // claiming encryption was stripped so it could be read — untrue of it.
  it("passes an owner-password-only PDF through UNTOUCHED", async () => {
    const ownerOnly = readFileSync(
      path.join(__dirname, "__fixtures__", "owner-only-sample.pdf"),
    )
    const result = await decryptPdfIfEncrypted(ownerOnly, ["0212040001084"])
    expect(result).toEqual({ ok: true, bytes: ownerOnly, decrypted: false })
  })

  it("passes a plain unencrypted PDF through UNTOUCHED", async () => {
    const plain = readFileSync(
      path.join(__dirname, "__fixtures__", "plain-sample.pdf"),
    )
    const result = await decryptPdfIfEncrypted(plain, ["0212040001084"])
    expect(result).toEqual({ ok: true, bytes: plain, decrypted: false })
  })
})

// Simulated by emptying PATH so spawn("qpdf") fails with ENOENT.
describe("decryptPdfIfEncrypted — when qpdf is unavailable", () => {
  const withoutQpdf = async (bytes: Buffer, candidates: string[]) => {
    vi.stubEnv("PATH", "/nonexistent")
    try {
      return await decryptPdfIfEncrypted(bytes, candidates)
    } finally {
      vi.unstubAllEnvs()
    }
  }

  // Failing these would take down intake for every ordinary PDF — bank
  // statements, payslips, ID copies — on a path that never needed qpdf.
  it("still stores an unencrypted PDF", async () => {
    const plain = readFileSync(
      path.join(__dirname, "__fixtures__", "plain-sample.pdf"),
    )
    expect(await withoutQpdf(plain, ["0212040001084"]))
      .toEqual({ ok: true, bytes: plain, decrypted: false })
  })

  it("refuses an encrypted PDF rather than storing it unreadable", async () => {
    expect(await withoutQpdf(encryptedPdf(), ["0212040001084"]))
      .toEqual({ ok: false, reason: "decrypt_failed" })
  })
})

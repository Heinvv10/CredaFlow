import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * South African banks password-protect emailed statements (and some payroll
 * providers do the same with payslips). `pdftoppm` cannot rasterise an
 * encrypted PDF, so extraction fails, `extractionResult` stays NULL, and the
 * disbursement gate correctly refuses to treat the document as banking
 * evidence. Staff cannot preview it in-app either.
 *
 * Intake strips the encryption once, so every later reader — extraction,
 * preview, re-extraction — sees an ordinary PDF. `qpdf --decrypt` is a
 * structural rewrite: it removes the encryption dictionary and leaves the
 * content streams byte-identical, unlike a re-render (`pdftocairo -pdf`)
 * which would degrade the only copy we keep.
 */

const QPDF_TIMEOUT_MS = 10_000
const PDF_MAGIC = Buffer.from("%PDF-")

/**
 * `qpdf --requires-password` exits 0 when a USER password is needed, 2 when
 * the file is not encrypted, and 3 when it is encrypted but opens freely
 * (owner-password-only: printing restricted, reading not). Only exit 0 needs
 * anything done to it.
 *
 * `--is-encrypted` cannot be used here: it returns 0 for owner-only files too,
 * which would rewrite a document that was already readable — discarding the
 * client's original for no benefit and recording an audit reason that is not
 * true of it.
 */
const QPDF_PASSWORD_REQUIRED = 0

/**
 * qpdf exits 3 for "operation succeeded with warnings" and STILL writes a
 * complete output file — routinely, for a statement whose cross-reference
 * table needs reconstructing because a mail client re-saved it. Treating 3 as
 * failure rejects documents that decrypted perfectly well.
 */
const QPDF_SUCCESS_CODES = new Set([0, 3])

export type PdfDecryptOutcome =
  | { ok: true; bytes: Buffer; decrypted: boolean }
  | { ok: false; reason: "password_unknown" | "decrypt_failed" }

/** Exported so the "never shell out for a non-PDF" guard is directly testable. */
export function isPdf(bytes: Buffer): boolean {
  return bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)
}

/**
 * Encryption detection WITHOUT qpdf, used only to decide how to fail when the
 * binary is unavailable. An encrypted PDF names /Encrypt in its trailer.
 * Deliberately biased toward "encrypted": a false positive refuses one upload,
 * whereas a false negative stores an unreadable document that the
 * disbursement gate would later reject with no explanation.
 */
function looksEncrypted(bytes: Buffer): boolean {
  return bytes.includes(Buffer.from("/Encrypt"))
}

/**
 * The password is written to qpdf's stdin rather than passed as `--password=`,
 * so it never appears in the process list. Nothing derived from the password
 * is returned to the caller — qpdf's own stderr names the file, not the
 * secret, but callers still build their own messages rather than forwarding it.
 */
type QpdfRun =
  | { ran: true; code: number }
  /** qpdf could not be executed at all — a missing binary, not a bad password. */
  | { ran: false }

function runQpdf(
  args: readonly string[],
  password?: string,
): Promise<QpdfRun> {
  return new Promise((resolve) => {
    // stdout/stderr are ignored rather than piped: nothing reads them, and a
    // run that emits more than the pipe buffer would otherwise block until the
    // timeout kills it.
    const child = spawn("qpdf", args, {
      timeout: QPDF_TIMEOUT_MS,
      stdio: ["pipe", "ignore", "ignore"],
    })
    let settled = false
    child.on("error", () => {
      if (settled) return
      settled = true
      resolve({ ran: false })
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      // A signalled kill (timeout) reports a null code; treat it as failure.
      resolve({ ran: true, code: code ?? 1 })
    })
    // stdin is only consumed by `--password-file=-`; closing it unconditionally
    // keeps the child from blocking when no password is supplied.
    child.stdin.on("error", () => {
      // A wrong password can make qpdf exit before stdin drains. The exit code
      // is the signal we act on, so an EPIPE here is not itself an error.
    })
    if (password !== undefined) child.stdin.write(password)
    child.stdin.end()
  })
}

/**
 * Returns the bytes to store. A non-PDF, or a PDF that is not encrypted, is
 * passed through untouched so the caller can hash and store one buffer either
 * way. Fails closed: if the document is encrypted and no candidate opens it,
 * the caller must not silently store an unreadable file.
 */
export async function decryptPdfIfEncrypted(
  bytes: Buffer,
  passwordCandidates: readonly string[],
): Promise<PdfDecryptOutcome> {
  if (!isPdf(bytes)) return { ok: true, bytes, decrypted: false }

  const dir = await mkdtemp(join(tmpdir(), "pdf-decrypt-"))
  const input = join(dir, "in.pdf")
  const output = join(dir, "out.pdf")
  try {
    await writeFile(input, bytes)

    const probe = await runQpdf(["--requires-password", input])

    // qpdf is unavailable (not installed, not on PATH). Failing every PDF here
    // would take down intake for ordinary unencrypted documents that never
    // needed qpdf at all. Only refuse the ones we can independently see are
    // encrypted; everything else is stored exactly as before.
    if (!probe.ran) {
      return looksEncrypted(bytes)
        ? { ok: false, reason: "decrypt_failed" }
        : { ok: true, bytes, decrypted: false }
    }

    // Not encrypted, or encrypted but readable without a password. Either way
    // it already extracts and previews, so it is stored untouched — rewriting
    // it would discard the client's original for nothing.
    if (probe.code !== QPDF_PASSWORD_REQUIRED) {
      return { ok: true, bytes, decrypted: false }
    }

    // Candidates are passed through opaquely. Trimming or de-duping them here
    // would be unobservable at best — a redundant candidate only costs one
    // failed qpdf run — and wrong at worst, since a password may legitimately
    // contain whitespace. Cleaning belongs where the value is read out of the
    // database, in clientPdfPasswordCandidates.
    for (const candidate of passwordCandidates) {
      const attempt = await runQpdf(
        ["--decrypt", "--password-file=-", input, output],
        candidate,
      )
      if (!attempt.ran || !QPDF_SUCCESS_CODES.has(attempt.code)) continue
      // Exit 3 means warnings were emitted ("resulting file may have some
      // problems"), so the output is only trusted once it is confirmed to be a
      // real, non-empty PDF — this becomes the client's stored document.
      //
      // UNTESTED defence-in-depth: no fixture makes qpdf report success and
      // then emit a corrupt file, so no test covers this branch. Kept rather
      // than dropped because the consequence is storing a corrupt bank
      // statement, not merely a wasted call.
      const decrypted = await readFile(output).catch(() => null)
      if (decrypted && decrypted.length > 0 && isPdf(decrypted)) {
        return { ok: true, bytes: decrypted, decrypted: true }
      }
    }
    return { ok: false, reason: "password_unknown" }
  } catch {
    // A missing qpdf binary or unreadable temp file must not be mistaken for a
    // wrong password — the remediation differs (fix the image vs. get the
    // password), so the reasons stay distinct.
    return { ok: false, reason: "decrypt_failed" }
  } finally {
    // The plaintext of a client bank statement must not outlive the request.
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Every password-protected document observed in production opened with the
 * client's 13-digit SA ID number — the convention SA banks use for emailed
 * statements. Deliberately not widened to speculative variants: each extra
 * candidate is another decrypt attempt against a real client's document.
 */
export function clientPdfPasswordCandidates(
  client: { idNumber?: string | null },
): string[] {
  const idNumber = client.idNumber?.trim()
  return idNumber ? [idNumber] : []
}

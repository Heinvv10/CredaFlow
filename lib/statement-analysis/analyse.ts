/**
 * The statement pipeline: file facts → bank → text reader (Capitec, FNB with a
 * text layer) or vision reader (everything else) → balance check.
 *
 * Pure of the database: lib/statement-analysis/persist.ts stores the result.
 */
import { checkBalance } from "./balance-check"
import { readCapitec } from "./capitec"
import { detectBank, TEXT_READER_BANKS } from "./detect-bank"
import { readFnb } from "./fnb"
import { countIncrementalUpdates, readPdf, type PdfContent } from "./pdf-tools"
import { renderPdfPages } from "./render-pages"
import type { AuthenticityFacts, BankCode, StatementRead } from "./types"
import { readWithVlm, VLM_MAX_PAGES, VlmUnavailableError } from "./vlm-reader"

/** Bump when a reader changes what it returns for the same bytes. */
export const PARSER_VERSION = "statement-v1"

/** Fewer non-space characters than this and the PDF is treated as a scan. */
const MIN_TEXT_LAYER_CHARS = 200

export interface StatementAnalysisResult {
  method: "TEXT" | "VLM"
  status: "READ" | "UNREADABLE" | "UNSUPPORTED"
  bank: BankCode | null
  read: StatementRead | null
  balanceCheck: "PASS" | "FAIL" | "NOT_APPLICABLE"
  balanceDiffCents: number | null
  authenticity: AuthenticityFacts
}

function textReader(bank: BankCode, pdf: PdfContent): StatementRead | null {
  if (bank === "CAPITEC") return readCapitec(pdf.pages)
  if (bank === "FNB") return readFnb(pdf.pages, pdf.words)
  return null
}

function result(
  method: "TEXT" | "VLM",
  bank: BankCode | null,
  read: StatementRead | null,
  authenticity: AuthenticityFacts,
  unreadable: "UNREADABLE" | "UNSUPPORTED" = "UNREADABLE",
): StatementAnalysisResult {
  if (!read) {
    return { method, status: unreadable, bank, read: null, balanceCheck: "NOT_APPLICABLE", balanceDiffCents: null, authenticity }
  }
  const balance = checkBalance(read)
  return { method, status: "READ", bank, read, balanceCheck: balance.result, balanceDiffCents: balance.diffCents, authenticity }
}

/**
 * With `allowVlm: false`, a document that needs the vision reader throws
 * VlmUnavailableError instead of calling it (see persist.ts).
 */
export async function analyseStatement(
  bytes: Buffer,
  mimeType: string,
  opts: { allowVlm: boolean } = { allowVlm: true },
): Promise<StatementAnalysisResult> {
  const vlm = (images: Buffer[], mime: string) => {
    if (!opts.allowVlm) throw new VlmUnavailableError("vision read deferred")
    return readWithVlm(images, mime)
  }
  if (mimeType !== "application/pdf") {
    const facts: AuthenticityFacts = {
      producer: null, creator: null, createdAt: null, modifiedAt: null, incrementalUpdates: 0, signals: ["NOT_A_PDF"],
    }
    return result("VLM", null, await vlm([bytes], mimeType), facts)
  }

  const pdf = await readPdf(bytes)
  const text = pdf.pages.join("\n")
  const hasText = text.replace(/\s/g, "").length >= MIN_TEXT_LAYER_CHARS
  const authenticity: AuthenticityFacts = {
    producer: pdf.info.producer,
    creator: pdf.info.creator,
    createdAt: pdf.info.createdAt,
    modifiedAt: pdf.info.modifiedAt,
    incrementalUpdates: countIncrementalUpdates(bytes),
    signals: hasText ? [] : ["TEXT_LAYER_ABSENT"],
  }
  const bank = hasText ? detectBank(text) : null

  if (bank && TEXT_READER_BANKS.includes(bank)) {
    const read = textReader(bank, pdf)
    if (read && read.transactions.length > 0) return result("TEXT", bank, read, authenticity)
    authenticity.signals.push("TEXT_LAYOUT_UNRECOGNISED")
  }

  if (pdf.info.pages > VLM_MAX_PAGES) return result("VLM", bank, null, authenticity, "UNSUPPORTED")
  if (!opts.allowVlm) throw new VlmUnavailableError("vision read deferred")
  const read = await vlm(await renderPdfPages(bytes, pdf.info.pages), "image/jpeg")
  return result("VLM", bank, read, authenticity)
}

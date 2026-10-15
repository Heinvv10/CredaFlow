/**
 * The statement pipeline: file facts → bank → text reader (Capitec, FNB,
 * Nedbank, ABSA, Standard Bank, Discovery with a text layer) or vision reader
 * (everything else) → balance check.
 *
 * Pure of the database: lib/statement-analysis/persist.ts stores the result.
 */
import { readAbsa } from "./absa"
import { checkBalance } from "./balance-check"
import { readCapitec } from "./capitec"
import { detectBanks } from "./detect-bank"
import { readDiscovery } from "./discovery"
import { readFnb } from "./fnb"
import { readNedbank } from "./nedbank"
import { countIncrementalUpdates, readPdf, type PdfContent } from "./pdf-tools"
import { renderPdfPages } from "./render-pages"
import { readStandardBank } from "./standard-bank"
import type { AuthenticityFacts, BankCode, StatementRead } from "./types"
import { readWithVlm, VLM_MAX_PAGES, VlmUnavailableError } from "./vlm-reader"

/** Bump when a reader changes what it returns for the same bytes. */
export const PARSER_VERSION = "statement-v3"

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

/** The banks with a text reader; every other bank goes to the vision reader. */
const TEXT_READERS: Partial<Record<BankCode, (pdf: PdfContent) => StatementRead | null>> = {
  CAPITEC: (pdf) => readCapitec(pdf.pages),
  FNB: (pdf) => readFnb(pdf.pages, pdf.words),
  NEDBANK: (pdf) => readNedbank(pdf.pages, pdf.words),
  ABSA: (pdf) => readAbsa(pdf.pages, pdf.words),
  STANDARD_BANK: (pdf) => readStandardBank(pdf.pages),
  DISCOVERY: (pdf) => readDiscovery(pdf.pages, pdf.words),
}

/** Statements cover days to months; a longer or inverted period is a misread (or a forgery's typo). */
const MAX_PERIOD_DAYS = 400

/** Drops a period that cannot be a statement's: inverted, absurdly long, or ending in the future. */
function plausiblePeriod(read: StatementRead): StatementRead {
  const { periodStart, periodEnd } = read
  if (!periodStart || !periodEnd) return read
  const days = (Date.parse(periodEnd) - Date.parse(periodStart)) / 86_400_000
  const future = Date.parse(periodEnd) > Date.now() + 31 * 86_400_000
  return days < 0 || days > MAX_PERIOD_DAYS || future ? { ...read, periodStart: null, periodEnd: null } : read
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
  return { method, status: "READ", bank, read: plausiblePeriod(read), balanceCheck: balance.result, balanceDiffCents: balance.diffCents, authenticity }
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
    signals: [...(hasText ? [] : ["TEXT_LAYER_ABSENT"]), ...(pdf.info.metadataAmbiguous ? ["METADATA_AMBIGUOUS"] : [])],
  }
  const banks = hasText ? detectBanks(text) : []
  // The first bank whose reader reads the text is the statement's; with none, the first marker's.
  for (const candidate of banks) {
    const read = TEXT_READERS[candidate]?.(pdf)
    if (read && read.transactions.length > 0) {
      if (read.openingDerived) authenticity.signals.push("OPENING_DERIVED")
      if (read.closingDerived) authenticity.signals.push("CLOSING_DERIVED")
      // Rows printed without a balance (ABSA eStatement) are checked only together, at the next
      // printed balance: an equal and opposite pair of edits among them cancels out.
      if (read.transactions.some((t) => t.balanceCents === null && !t.nonPosting)) authenticity.signals.push("ROWS_WITHOUT_BALANCE")
      return result("TEXT", candidate, read, authenticity)
    }
  }
  const bank = banks[0] ?? null
  if (bank && TEXT_READERS[bank]) authenticity.signals.push("TEXT_LAYOUT_UNRECOGNISED")

  if (pdf.info.pages > VLM_MAX_PAGES) return result("VLM", bank, null, authenticity, "UNSUPPORTED")
  if (!opts.allowVlm) throw new VlmUnavailableError("vision read deferred")
  const read = await vlm(await renderPdfPages(bytes, pdf.info.pages), "image/jpeg")
  return result("VLM", bank, read, authenticity)
}

/**
 * Prints the layout of one bank's corpus statements as masked shapes, so a
 * text reader can be written without anyone reading a client's statement.
 *
 *   STATEMENT_CORPUS_DIR=/secure/path/to/corpus \
 *     npx tsx scripts/statement-layout-shapes.ts NEDBANK [--lines 60] [--files 3] [--pages 2] [--bbox-page 1] [--producer PREFIX]
 *       [--id DOCUMENT_ID --page N]
 *
 * Every letter prints as `a` and every digit as `9`, except words that occur
 * on the statements of at least BOILERPLATE_SHARE of that bank's accounts (and
 * at least MIN_LABEL_ACCOUNTS) and carry no digit: those are the bank's own labels ("Opening",
 * "Balance"), not a client's. Accounts, not files, are counted, so a client
 * with many statements in the corpus cannot make their own name a "label".
 * Word boxes print the same way, with their x positions. Also printed: per-file page
 * counts and producers (file metadata), and how often each label shows up.
 * Never prints a document's own words, amounts, names or account numbers.
 */
import { readFileSync } from "node:fs"
import { loadCorpus } from "@/lib/statement-analysis/accuracy/run"
import { detectBank } from "@/lib/statement-analysis/detect-bank"
import { readPdf, type PdfContent } from "@/lib/statement-analysis/pdf-tools"

const BOILERPLATE_SHARE = 0.6
/**
 * A label must also appear for at least this many accounts. Three was not
 * enough: three statements of one client under different reference numbers
 * passed a client's surname and town as "labels".
 */
const MIN_LABEL_ACCOUNTS = 5

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}
const bank = process.argv[2]
const maxLines = arg("--lines", 60)
const maxFiles = arg("--files", 3)
const boxPage = arg("--bbox-page", 1)
const textPages = arg("--pages", 2)
const producerIdx = process.argv.indexOf("--producer")
/** Only files whose producer starts with this: one bank can have several layouts. */
const producer = producerIdx >= 0 ? process.argv[producerIdx + 1] : null
const idIdx = process.argv.indexOf("--id")
/** Only this document, and only page --page of it. */
const onlyId = idIdx >= 0 ? process.argv[idIdx + 1] : null
const onlyPage = arg("--page", 0)

const wordsOf = (text: string) => new Set(text.split(/\s+/).filter((w) => w && !/\d/.test(w)))

function mask(text: string, vocab: Set<string>): string {
  return text.replace(/\S+/g, (w) => (vocab.has(w) ? w : w.replace(/[A-Za-z]/g, "a").replace(/\d/g, "9").replace(/[^\sa9.,:/()\-+*%R]/g, "#")))
}

async function main() {
  const dir = process.env.STATEMENT_CORPUS_DIR
  if (!dir || !bank) throw new Error("usage: STATEMENT_CORPUS_DIR=… statement-layout-shapes.ts <BANK>")
  const files: Array<{ id: string; pdf: PdfContent }> = []
  for (const f of loadCorpus(dir).filter((f) => f.mimeType === "application/pdf")) {
    const pdf = await readPdf(readFileSync(f.path)).catch(() => null)
    if (pdf && detectBank(pdf.pages.join("\n")) === bank) files.push({ id: f.id, pdf })
  }
  // One word set per account. The account key is the smallest 9+ digit run on
  // page 1 that most of the bank's files do not share (those are its phone and
  // registration numbers); a file without one is its own account.
  const runsOf = (pdf: PdfContent) => new Set((pdf.pages[0] ?? "").match(/\d{9,}/g) ?? [])
  const runCounts = new Map<string, number>()
  for (const { pdf } of files) for (const r of runsOf(pdf)) runCounts.set(r, (runCounts.get(r) ?? 0) + 1)
  const accounts = new Map<string, Set<string>>()
  for (const { id, pdf } of files) {
    const key = [...runsOf(pdf)].filter((r) => runCounts.get(r)! < files.length / 2).sort()[0] ?? id
    const words = accounts.get(key) ?? new Set<string>()
    for (const w of wordsOf(pdf.pages.join("\n"))) words.add(w)
    accounts.set(key, words)
  }
  const counts = new Map<string, number>()
  for (const words of accounts.values()) for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1)
  const vocab = new Set([...counts].filter(([, n]) => n >= Math.max(MIN_LABEL_ACCOUNTS, accounts.size * BOILERPLATE_SHARE)).map(([w]) => w))

  process.stdout.write(`# ${bank}: ${files.length} PDFs, ${accounts.size} accounts\n`)
  for (const { id, pdf } of files) process.stdout.write(`${id} pages=${pdf.info.pages} producer=${pdf.info.producer ?? "-"} creator=${pdf.info.creator ?? "-"}\n`)
  process.stdout.write(`\n# labels (on ≥${BOILERPLATE_SHARE * 100}% of accounts)\n${[...vocab].sort().join(" ")}\n`)

  // Labels come from all of the bank's files; --producer only narrows what is shown.
  const shown = files.filter(({ id, pdf }) => (!producer || (pdf.info.producer ?? "").startsWith(producer)) && (!onlyId || id === onlyId))
  for (const { id, pdf } of shown.slice(0, maxFiles)) {
    process.stdout.write(`\n## ${id} layout (masked)\n`)
    pdf.pages.forEach((page, p) => {
      if (onlyPage ? p + 1 !== onlyPage : p >= textPages) return
      process.stdout.write(`--- page ${p + 1}\n`)
      for (const line of page.split("\n").slice(0, maxLines)) process.stdout.write(`${mask(line, vocab)}\n`)
    })
    process.stdout.write(`\n## ${id} word boxes page ${boxPage} (x0-x1 y masked)\n`)
    for (const w of (pdf.words[boxPage - 1] ?? []).slice(0, maxLines * 8)) {
      process.stdout.write(`${w.xMin.toFixed(0)}-${w.xMax.toFixed(0)} ${w.yMin.toFixed(0)} ${mask(w.text, vocab)}\n`)
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : "failed")
  process.exit(1)
})

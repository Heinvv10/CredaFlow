/**
 * Statement reader accuracy over the off-repo corpus (README.md). Pure
 * helpers: the integration test drives them.
 *
 * The report carries counts and document IDs only — never a name, an account
 * number, an amount or a transaction description. The corpus is real client
 * data and the report is pasted into PRs.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { documentAuthenticity } from "@/lib/credit-checks/document-authenticity"
import { EXPECTED_PRODUCERS } from "@/lib/credit-checks/policy"
import type { StatementAnalysisResult } from "../analyse"

export interface CorpusFile {
  id: string
  mimeType: string
  path: string
}

export interface Outcome {
  id: string
  bank: string | null
  method: "TEXT" | "VLM" | "SKIPPED"
  status: string
  balanceCheck: string
  /** The PDF was written by the program the bank's own statements come from. */
  bankProduced: boolean
  authenticityCodes: string[]
}

/** BANK_STATEMENT rows of the corpus manifest (id|type|mime|bank|sha256|date). */
export function loadCorpus(dir: string): CorpusFile[] {
  const ext: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpeg", "image/png": "png" }
  return readFileSync(join(dir, "manifest.psv"), "utf8").trim().split("\n").slice(1)
    .map((line) => line.split("|"))
    .filter(([, type, mime]) => type === "BANK_STATEMENT" && ext[mime])
    .map(([id, , mime]) => ({ id, mimeType: mime, path: join(dir, "bank_statement", `${id}.${ext[mime]}`) }))
}

export function outcomeOf(id: string, r: StatementAnalysisResult): Outcome {
  const expected = r.bank ? EXPECTED_PRODUCERS[r.bank] : undefined
  const bankProduced = !!expected && expected.producer.some((p) => (r.authenticity.producer ?? "").startsWith(p))
  // The authenticity check alone: no client to name-match and no application
  // date to call it stale against, so those two codes cannot fire here.
  const codes = documentAuthenticity({
    applicationId: "corpus",
    applicationDate: "0001-01-01",
    clientName: "",
    monthlyIncomeCents: null,
    payslip: null,
    debts: [],
    deletedStatementIds: [],
    mismatchedPayslipIds: [],
    deletedPayslipIds: [],
    priorOpenFlagApplicationIds: [],
    statements: [{
      documentId: id, analysisId: id, contentSha256: id, state: r.status, method: r.method, bank: r.bank,
      read: r.read, balanceCheck: r.balanceCheck, authenticity: r.authenticity,
    }],
  }).map((c) => c.code)
  return { id, bank: r.bank, method: r.method, status: r.status, balanceCheck: r.balanceCheck, bankProduced, authenticityCodes: [...new Set(codes)].sort() }
}

const pct = (n: number, d: number) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`)

/** TEXT balance PASS over Capitec + FNB PDFs; `bankProducedOnly` narrows to the banks' own files. */
export function textPassRate(outcomes: Outcome[], bankProducedOnly: boolean): { pass: number; total: number } {
  const pool = outcomes.filter((o) => (o.bank === "CAPITEC" || o.bank === "FNB") && o.method !== "SKIPPED"
    && (!bankProducedOnly || o.bankProduced))
  return { pass: pool.filter((o) => o.method === "TEXT" && o.balanceCheck === "PASS").length, total: pool.length }
}

export function formatReport(outcomes: Outcome[]): string {
  const lines: string[] = ["# Statement reader accuracy", "", "| bank | method | files | READ | balance PASS | PASS % |", "|---|---|---|---|---|---|"]
  const groups = new Map<string, Outcome[]>()
  for (const o of outcomes) {
    const key = `${o.bank ?? "UNDETECTED"}|${o.method}`
    groups.set(key, [...(groups.get(key) ?? []), o])
  }
  for (const [key, os] of [...groups].sort()) {
    const [bank, method] = key.split("|")
    const read = os.filter((o) => o.status === "READ").length
    const pass = os.filter((o) => o.balanceCheck === "PASS").length
    lines.push(`| ${bank} | ${method} | ${os.length} | ${read} | ${pass} | ${pct(pass, os.length)} |`)
  }
  const own = textPassRate(outcomes, true)
  const all = textPassRate(outcomes, false)
  lines.push("", `Capitec + FNB, bank-produced PDFs: TEXT balance PASS ${own.pass}/${own.total} (${pct(own.pass, own.total)})`)
  lines.push(`Capitec + FNB, all PDFs (incl. re-saved by another program): ${all.pass}/${all.total} (${pct(all.pass, all.total)})`)

  lines.push("", "## Authenticity signals by document ID", "")
  const byCode = new Map<string, string[]>()
  for (const o of outcomes) for (const c of o.authenticityCodes) byCode.set(c, [...(byCode.get(c) ?? []), o.id])
  if (byCode.size === 0) lines.push("None.")
  for (const [code, ids] of [...byCode].sort()) lines.push(`- **${code}** (${ids.length}): ${ids.join(", ")}`)
  return lines.join("\n")
}

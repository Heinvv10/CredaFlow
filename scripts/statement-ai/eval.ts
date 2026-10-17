/**
 * Statement AI evaluation against the local model (goal 2026-10-17 §8.4, §8.5).
 *
 * Synthetic applications only (never the statement corpus): each is generated
 * from a seed with its figures known, so every question has an answer the
 * generator computed without the tools. Features A and B are planned with the
 * production buildPlans/produce; feature C with the production answerQuestion.
 *
 *   npx tsx scripts/statement-ai/eval.ts [--apps 30] [--runs 3] [--out report.json]
 *
 * Needs VLM_API_URL and VLM_MODEL. Runs only in the model window (model-window.ts).
 */
import { writeFileSync } from "node:fs"
import { runChecks } from "@/lib/credit-checks/run-checks"
import { facts as factsOf, statement } from "@/lib/credit-checks/facts.test-helpers"
import { computeInsights, distinctRows } from "@/lib/statement-analysis/insights"
import type { StatementTransaction } from "@/lib/statement-analysis/types"
import { buildPlans, produce } from "@/lib/statement-ai/generate"
import { answerQuestion } from "@/lib/statement-ai/ask/answer"
import { askRows } from "@/lib/statement-ai/ask/tools"
import { rand } from "@/lib/statement-ai/format"
import { assertModelWindow } from "./model-window"

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

// ── Synthetic applications ──────────────────────────────────────────────────

function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MERCHANTS = ["KOPANO FRESH FOODS", "MAFIKA FUEL STOP", "LETHABO PHARMACY", "NOMSA HAIR STUDIO", "THABA BUTCHERY", "ZENZELE HARDWARE", "AMANDLA BOOKS", "UBUNTU CAFE", "MOJA CELL SHOP", "INDLOVU TAXI RANK"]
const EMPLOYERS = ["SYNTHCO", "ACME WORKS", "BLUEGUM MILLS", "KAROO LOGISTICS"]
const LANDLORDS = ["SYNTH RENTALS", "MONDE PROPERTIES", "VUKA HOUSING"]

interface App {
  id: string
  seed: number
  clientName: string
  declaredExpensesCents: number
  rows: StatementTransaction[]
  months: string[]
  employerKey: string
  questions: Array<{ template: string; question: string; expected: string }>
}

const pad = (n: number) => String(n).padStart(2, "0")
const lastDay = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate()

function generateApp(seed: number): App {
  const r = prng(seed)
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]
  const cents = (lo: number, hi: number) => Math.round((lo + r() * (hi - lo)) * 100)
  const startMonth = 4 + Math.floor(r() * 3)
  const months = [0, 1, 2].map((i) => `2026-${pad(startMonth + i)}`)
  const employer = pick(EMPLOYERS)
  const landlord = pick(LANDLORDS)
  const net = cents(9_000, 30_000)
  const rent = Math.round(cents(3_000, 9_000) / 100) * 100
  const payDay = 20 + Math.floor(r() * 8)
  const shops = MERCHANTS.filter(() => r() < 0.6)
  const gambling = r() < 0.4
  const loan = r() < 0.5
  const rows: Array<Omit<StatementTransaction, "balanceCents" | "page">> = []
  for (const m of months) {
    rows.push({ date: `${m}-${pad(payDay)}`, description: `Payment Received: SALARY ${employer}`, amountCents: net })
    rows.push({ date: `${m}-01`, description: `Payment To: ${landlord}`, amountCents: -rent })
    if (loan) rows.push({ date: `${m}-05`, description: "DebiCheck Debit: SYNTHLEND FINANCE", amountCents: -125_000 })
    if (gambling) rows.push({ date: `${m}-${pad(10 + Math.floor(r() * 8))}`, description: "Card Purchase: HOLLYWOODBETS", amountCents: -cents(200, 2_500) })
    for (const shop of shops) {
      const n = Math.floor(r() * 5)
      for (let i = 0; i < n; i++) rows.push({ date: `${m}-${pad(1 + Math.floor(r() * (lastDay(m) - 1)))}`, description: `Card Purchase: ${shop}`, amountCents: -cents(20, 950) })
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description))
  const full = rows.map((t) => ({ ...t, balanceCents: null, page: 1 }))
  const id = `eval-${seed}`
  return { id, seed, clientName: "T TESTER", declaredExpensesCents: cents(3_000, 12_000), rows: full, months, employerKey: `SALARY ${employer}`, questions: questionsFor(full, months, employer, landlord, shops, r) }
}

// Known answers, computed from the generated rows (not by the tools).
function questionsFor(rows: StatementTransaction[], months: string[], employer: string, landlord: string, shops: string[], r: () => number) {
  const payeeOf = (t: StatementTransaction) => t.description.slice(t.description.lastIndexOf(":") + 1).trim()
  const out = (t: StatementTransaction) => t.amountCents < 0
  const sumAbs = (ts: StatementTransaction[]) => ts.reduce((s, t) => s + Math.abs(t.amountCents), 0)
  const inMonth = (m: string) => (t: StatementTransaction) => t.date.startsWith(m)
  const shop = shops.length ? shops[Math.floor(r() * shops.length)] : landlord
  const month = months[Math.floor(r() * 3)]
  const all = [
    { template: "payee-total", question: `How much was paid to ${shop} in total?`, expected: rand(sumAbs(rows.filter((t) => payeeOf(t) === shop))) },
    { template: "payee-count", question: `How many payments were made to ${shop}?`, expected: String(rows.filter((t) => payeeOf(t) === shop).length) },
    { template: "month-in", question: `What was the total money in during ${month}?`, expected: rand(sumAbs(rows.filter((t) => !out(t) && inMonth(month)(t)))) },
    { template: "month-out", question: `What was the total money out during ${month}?`, expected: rand(sumAbs(rows.filter((t) => out(t) && inMonth(month)(t)))) },
    { template: "big-debits", question: "How many debits were larger than R1 000?", expected: String(rows.filter((t) => out(t) && Math.abs(t.amountCents) > 100_000).length) },
    { template: "payee-month", question: `How much was paid to ${shop} in ${month}?`, expected: rand(sumAbs(rows.filter((t) => payeeOf(t) === shop && inMonth(month)(t)))) },
    { template: "salary-avg", question: "What was the average salary credit?", expected: (() => { const s = rows.filter((t) => t.description.includes(`SALARY ${employer}`)); return rand(Math.round(sumAbs(s) / s.length)) })() },
    { template: "rent-total", question: `How much rent was paid to ${landlord} over the statement period?`, expected: rand(sumAbs(rows.filter((t) => payeeOf(t) === landlord))) },
    { template: "debit-count", question: "How many debits are on the statement in total?", expected: String(rows.filter(out).length) },
    { template: "income-total", question: `How much did ${employer} pay in over the whole period?`, expected: rand(sumAbs(rows.filter((t) => t.description.includes(`SALARY ${employer}`)))) },
  ]
  // Two per application, rotating so every template is asked.
  const start = Math.floor(r() * all.length)
  return [all[start], all[(start + 5) % all.length]]
}

// ── The model, timed ────────────────────────────────────────────────────────

interface CallStat { kind: string; ms: number; tokensIn: number | null; tokensOut: number | null }
const calls: CallStat[] = []

function asker(kind: string) {
  return async (prompt: string, maxTokens: number): Promise<string> => {
    const started = Date.now()
    const res = await fetch(`${process.env.VLM_API_URL!.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ model: process.env.VLM_MODEL, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0 }),
    })
    if (!res.ok) throw new Error(`model responded ${res.status}`)
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
    calls.push({ kind, ms: Date.now() - started, tokensIn: body.usage?.prompt_tokens ?? null, tokensOut: body.usage?.completion_tokens ?? null })
    return body.choices?.[0]?.message?.content ?? ""
  }
}

// ── Scoring ─────────────────────────────────────────────────────────────────

/** Every figure-shaped token an answer shows, for a cross-check independent of the post-check. */
const FIGURES = /R\s?\d{1,3}(?:[ ,]\d{3})*(?:\.\d{2})?|\b\d+\b/g

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"]

/** The expected figure shown, as digits or (a count up to twenty) as a word: the post-check allows a word only for a figure it was given. */
function scoreAnswer(text: string, expected: string): "exact" | "wrong" {
  const shown = (text.match(FIGURES) ?? []).map((f) => f.replace(/,/g, " "))
  const asWord = /^\d+$/.test(expected) && Number(expected) <= 20 && new RegExp(`\\b${WORDS[Number(expected)]}\\b`, "i").test(text)
  return shown.includes(expected) || asWord ? "exact" : "wrong"
}

/** A rejection reason, figures blanked; a vocabulary miss keeps its word (the calibration needs it). */
const reasonKey = (r: string) => (r.startsWith("word outside") ? r : r.replace(/"[^"]*"/g, "\"…\""))

const pctOf = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0)
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0)

async function main() {
  assertModelWindow()
  if (!process.env.VLM_API_URL || !process.env.VLM_MODEL) throw new Error("VLM_API_URL and VLM_MODEL are required")
  const appCount = Number(arg("apps", "30"))
  const runs = Number(arg("runs", "3"))
  const out = arg("out", "statement-ai-eval.json")
  const apps = Array.from({ length: appCount }, (_, i) => generateApp(1000 + i))

  const report: Record<string, unknown> = { model: process.env.VLM_MODEL, apps: appCount, questions: apps.length * 2, runs: [] as unknown[] }
  const examples: unknown[] = []
  for (let run = 0; run < runs; run++) {
    const ab = { summaries: 0, summariesOk: 0, explanations: 0, explanationsOk: 0, reasons: {} as Record<string, number> }
    const c = { asked: 0, exact: 0, rejected: 0, wrongShown: 0, reasons: {} as Record<string, number>, byTemplate: {} as Record<string, { asked: number; exact: number; rejected: number; wrong: number }> }
    for (const app of apps) {
      // statement() derives the running balances from the rows.
      const st = statement(app.rows)
      const read = { ...st.read!, accountHolderName: app.clientName, periodStart: `${app.months[0]}-01`, periodEnd: `${app.months[2]}-${lastDay(app.months[2])}` }
      st.read = read
      const insights = computeInsights([{ documentId: "doc-1", bank: "CAPITEC", balanceCheck: "PASS", read }], { clientName: app.clientName, declaredExpensesCents: app.declaredExpensesCents })
      const flags = runChecks(factsOf({ applicationDate: `${app.months[2]}-${lastDay(app.months[2])}`, clientName: app.clientName, monthlyIncomeCents: app.rows.find((t) => t.description.includes("SALARY"))!.amountCents, declaredExpensesCents: app.declaredExpensesCents, statements: [st] }))
      const counted = distinctRows([{ documentId: "doc-1", bank: "CAPITEC", balanceCheck: "PASS", read }])
      const plans = buildPlans(insights, counted, flags as unknown as Parameters<typeof buildPlans>[2], new Map([["an-1", read.transactions]]), app.clientName)
      for (const plan of plans) {
        const res = await produce(plan, asker(plan.kind))
        if (plan.kind === "SUMMARY") { ab.summaries++; if (res.status === "OK") ab.summariesOk++ } else { ab.explanations++; if (res.status === "OK") ab.explanationsOk++ }
        if (res.status !== "OK") ab.reasons[reasonKey(res.rejectReason!)] = (ab.reasons[reasonKey(res.rejectReason!)] ?? 0) + 1
        if (run === 0 && examples.length < 12) examples.push({ app: app.id, kind: plan.kind, flag: plan.flagCode, status: res.status, reason: res.rejectReason, text: res.text })
      }
      const rows = askRows([{ ref: "S1", transactions: read.transactions.map((t, index) => ({ index, t })) }], app.clientName)
      for (const q of app.questions) {
        const res = await answerQuestion({ question: q.question, rows, raisedFlagCodes: flags.map((f) => f.code) }, asker("ANSWER"))
        const t = (c.byTemplate[q.template] ??= { asked: 0, exact: 0, rejected: 0, wrong: 0 })
        c.asked++
        t.asked++
        if (res.status !== "OK") {
          c.rejected++
          t.rejected++
          const reason = reasonKey(res.rejectReason!)
          c.reasons[reason] = (c.reasons[reason] ?? 0) + 1
        } else if (scoreAnswer(res.text, q.expected) === "exact") {
          c.exact++
          t.exact++
        } else {
          c.wrongShown++
          t.wrong++
          examples.push({ app: app.id, run, wrong: true, question: q.question, expected: q.expected, text: res.text, citations: res.citations.map((x) => ({ tool: x.tool, args: x.args, result: x.result })) })
        }
      }
      process.stderr.write(".")
    }
    process.stderr.write(`\nrun ${run + 1}: C exact ${c.exact}/${c.asked}, rejected ${c.rejected}, wrong shown ${c.wrongShown}; A ok ${ab.summariesOk}/${ab.summaries}; B ok ${ab.explanationsOk}/${ab.explanations}\n`)
    ;(report.runs as unknown[]).push({ run: run + 1, ab, c, cExactPct: pctOf(c.exact, c.asked), cRejectedPct: pctOf(c.rejected, c.asked), aRejectedPct: pctOf(ab.summaries - ab.summariesOk, ab.summaries), bRejectedPct: pctOf(ab.explanations - ab.explanationsOk, ab.explanations) })
  }
  const byKind = (k: string) => calls.filter((x) => x.kind === k)
  report.latency = Object.fromEntries(["SUMMARY", "FLAG_EXPLANATION", "ANSWER"].map((k) => [k, {
    calls: byKind(k).length,
    medianMs: median(byKind(k).map((x) => x.ms)),
    p95Ms: [...byKind(k).map((x) => x.ms)].sort((a, b) => a - b)[Math.floor(byKind(k).length * 0.95)] ?? 0,
    medianTokensIn: median(byKind(k).map((x) => x.tokensIn ?? 0)),
    medianTokensOut: median(byKind(k).map((x) => x.tokensOut ?? 0)),
  }]))
  report.minCExactPct = Math.min(...(report.runs as Array<{ cExactPct: number }>).map((r) => r.cExactPct))
  report.wrongShown = (report.runs as Array<{ c: { wrongShown: number } }>).reduce((s, r) => s + r.c.wrongShown, 0)
  report.examples = examples
  writeFileSync(out, JSON.stringify(report, null, 2))
  process.stderr.write(`report: ${out}\nmin C exact ${report.minCExactPct}%, wrong shown ${report.wrongShown}\n`)
}

void main()

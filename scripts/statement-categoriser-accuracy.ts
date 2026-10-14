/**
 * The categoriser's accuracy gate (goal 2026-10-14 §6.4) over labelled corpus
 * merchant keys (scripts/statement-merchant-keys.ts). Prints counts only, so
 * its output can go on a PR; `--show` also prints the disagreeing keys, for
 * the dev set only — rules are written from the dev set, never from held-out keys.
 *
 *   npx tsx scripts/statement-categoriser-accuracy.ts <keys.tsv> <labels.tsv> [--show]
 *
 * Gate: weighted by each key's row count, over every key that either the
 * labels or the categoriser put in CREDIT_INSTALMENT, GAMBLING, SALARY_INCOME
 * or a living category, the two agree on which of those four classes (living
 * combined) it is in; a living-vs-not confusion is an error. Required ≥ 95%.
 */
import { readFileSync } from "node:fs"
import { categorise, isLiving, type Category } from "@/lib/statement-analysis/categorise"

export const GATE = 0.95
const GATED = ["CREDIT_INSTALMENT", "GAMBLING", "SALARY_INCOME"]

/** The class a category counts as for the gate: the three named ones, LIVING, or OTHER. */
export function gateClass(c: Category): string {
  return isLiving(c) ? "LIVING" : GATED.includes(c) ? c : "OTHER"
}

export interface Scored { key: string; rows: number; label: Category; predicted: Category }

export function score(rows: Scored[]) {
  const inScope = rows.filter((r) => gateClass(r.label) !== "OTHER" || gateClass(r.predicted) !== "OTHER")
  const weight = (rs: Scored[]) => rs.reduce((s, r) => s + r.rows, 0)
  const agreeing = inScope.filter((r) => gateClass(r.label) === gateClass(r.predicted))
  const exact = rows.filter((r) => r.label === r.predicted)
  return {
    gate: weight(inScope) === 0 ? 1 : weight(agreeing) / weight(inScope),
    inScopeKeys: inScope.length,
    inScopeRows: weight(inScope),
    agreeingRows: weight(agreeing),
    exactRows: weight(exact),
    allRows: weight(rows),
    disagreements: inScope.filter((r) => gateClass(r.label) !== gateClass(r.predicted)),
  }
}

function main() {
  const [keysPath, labelsPath] = process.argv.slice(2)
  if (!keysPath || !labelsPath) throw new Error("usage: statement-categoriser-accuracy.ts <keys.tsv> <labels.tsv> [--show]")
  const counts = new Map(readFileSync(keysPath, "utf8").trim().split("\n").map((l) => l.split("\t")).map(([k, n]) => [k, Number(n)]))
  const rows: Scored[] = readFileSync(labelsPath, "utf8").trim().split("\n").map((l) => l.split("\t")).map(([key, label]) => ({
    key,
    rows: counts.get(key) ?? 0,
    label: label as Category,
    // The keys are debits: categorise them as money out, as on a statement.
    predicted: categorise({ date: "2026-01-01", description: key, amountCents: -1, balanceCents: null, page: 1 }, { clientName: null }).category,
  }))
  const s = score(rows)
  const pct = (n: number) => `${(100 * n).toFixed(1)}%`
  process.stdout.write(`keys labelled: ${rows.length} (${s.allRows} rows)\n`)
  process.stdout.write(`gate (credit, gambling, salary, living combined; row-weighted): ${s.agreeingRows}/${s.inScopeRows} = ${pct(s.gate)} — ${s.gate >= GATE ? "PASS" : "FAIL"} (≥ ${pct(GATE)})\n`)
  process.stdout.write(`in-scope keys: ${s.inScopeKeys}; disagreeing keys: ${s.disagreements.length}\n`)
  process.stdout.write(`exact category agreement, all keys (informative): ${s.exactRows}/${s.allRows} = ${pct(s.exactRows / s.allRows)}\n`)
  const confusions = new Map<string, number>()
  for (const r of s.disagreements) confusions.set(`${gateClass(r.label)} → ${gateClass(r.predicted)}`, (confusions.get(`${gateClass(r.label)} → ${gateClass(r.predicted)}`) ?? 0) + r.rows)
  for (const [k, n] of [...confusions].sort((a, b) => b[1] - a[1])) process.stdout.write(`  label → categoriser ${k}: ${n} rows\n`)
  if (process.argv.includes("--show")) for (const r of s.disagreements) process.stdout.write(`  ${r.key}\t${r.rows}\t${r.label}\t${r.predicted}\n`)
}

if (require.main === module) main()

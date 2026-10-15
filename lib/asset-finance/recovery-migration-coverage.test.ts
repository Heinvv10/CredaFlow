import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// Static: every rule the slice 4a migration hand-writes is exercised by a real
// call shape of the real-database suites, not merely mentioned in them.
//   constraint / unique index: a refuses(...) rule object `{ table, constraint: "N" }` / `{ index: "N" }`
//     (or `constraint: <name>` / `index: <name>` in a helper, with "N" passed to that helper as a string literal);
//   RAISE message: raiseOff(fn, M) with M a literal or a const of the file, or a clauseOff(...) / `replace: [...]`
//     clause that contains the message, or a part of the IF condition guarding that RAISE (clauseOff / without / `replace: [...]`).
// A name that appears only in a comment, a regex or an expect() does not count.
const DIR = __dirname
const sql = fs.readFileSync(path.join(process.cwd(), "prisma", "migrations", "20261015400000_asset_finance_recovery", "migration.sql"), "utf8")
const handWritten = sql.slice(sql.indexOf("-- Hand-written rules"))

/** Unique indexes the schema generates, which enforce a rule all the same (one payment, one invoice, one surrender per recovery or sale). */
const GENERATED_UNIQUE = ["RemarketingSale_taxInvoiceId_key", "Recovery_surrenderRequestId_key", "Recovery_proceedsPaymentId_key"]

const suites = fs.readdirSync(DIR).filter((f) => f.endsWith(".integration.test.ts")).map((f) => ({ file: f, source: fs.readFileSync(path.join(DIR, f), "utf8") }))

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
const unquote = (token: string) => token.slice(1, -1).replace(/\\(['"`])/g, "$1")

/** String consts of a file: `const NAME = "..."` (single literal). */
function constants(source: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of source.matchAll(/const (\w+)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\$]|\\.)*`)\s*(?:$|\n|,|;)/gm)) map.set(m[1], unquote(m[2]))
  return map
}

/** A call's argument list, balanced on parentheses, strings aware. */
function callArguments(source: string, name: string): string[] {
  const calls: string[] = []
  for (const m of source.matchAll(new RegExp(`\\b${name}\\(`, "g"))) {
    let depth = 1
    let i = m.index + m[0].length
    let quote = ""
    for (; i < source.length && depth > 0; i++) {
      const c = source[i]
      if (quote) {
        if (c === "\\") i++
        else if (c === quote) quote = ""
      } else if (c === '"' || c === "'" || c === "`") quote = c
      else if (c === "(") depth++
      else if (c === ")") depth--
    }
    calls.push(source.slice(m.index + m[0].length, i - 1))
  }
  return calls
}

/** The second top-level argument of a call, resolved to a string when it is a literal or a known const. */
function secondArgument(args: string, consts: Map<string, string>): string | null {
  let depth = 0
  let quote = ""
  let start = -1
  for (let i = 0; i < args.length; i++) {
    const c = args[i]
    if (quote) {
      if (c === "\\") i++
      else if (c === quote) quote = ""
    } else if (c === '"' || c === "'" || c === "`") quote = c
    else if ("([{".includes(c)) depth++
    else if (")]}".includes(c)) depth--
    else if (c === "," && depth === 0) {
      if (start < 0) start = i + 1
      else {
        const token = args.slice(start, i).trim()
        return /^["'`]/.test(token) ? unquote(token) : consts.get(token) ?? null
      }
    }
  }
  if (start < 0) return null
  const token = args.slice(start).trim()
  return /^["'`]/.test(token) ? unquote(token) : consts.get(token) ?? null
}

interface Evidence { constraints: Set<string>; indexes: Set<string>; raised: Set<string>; clauses: string[] }
const evidence: Evidence = { constraints: new Set(), indexes: new Set(), raised: new Set(), clauses: [] }
for (const { source: raw } of suites) {
  const source = stripComments(raw)
  const consts = constants(source)
  const literals = new Set([...source.matchAll(/"([A-Za-z]+_[A-Za-z0-9_]+)"/g)].map((m) => m[1]))
  const dynamicConstraint = /constraint: [a-z]\w*[ ,}]/.test(source)
  const dynamicIndex = /index: [a-z]\w*[ ,}]/.test(source)
  for (const m of source.matchAll(/table: "\w+", constraint: "(\w+)"/g)) evidence.constraints.add(m[1])
  for (const m of source.matchAll(/\bindex: "(\w+)"/g)) evidence.indexes.add(m[1])
  if (dynamicConstraint) for (const name of literals) evidence.constraints.add(name)
  if (dynamicIndex) for (const name of literals) evidence.indexes.add(name)
  for (const args of callArguments(source, "raiseOff")) {
    const message = secondArgument(args, consts)
    if (message) evidence.raised.add(message)
  }
  for (const call of ["clauseOff", "without"]) {
    for (const args of callArguments(source, call)) {
      const clause = secondArgument(args, consts)
      if (clause) evidence.clauses.push(clause)
    }
  }
  for (const m of source.matchAll(/replace: \[\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g)) evidence.clauses.push(unquote(m[1]))
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim()
/** The condition of the IF whose body raises the message at `at`: what a clauseOff of that rule takes out a part of. */
function guardingCondition(at: number): string {
  const before = handWritten.slice(0, at)
  const ifAt = Math.max(before.lastIndexOf("IF "), before.lastIndexOf("IF("), before.lastIndexOf("\nIF"))
  const thenAt = handWritten.indexOf("THEN", ifAt)
  return squash(handWritten.slice(ifAt + 2, thenAt))
}
const messages = [...handWritten.matchAll(/MESSAGE\s*=\s*(format\()?\s*'((?:[^']|'')*)'/g)].map((m) => ({
  text: m[2].replaceAll("''", "'"), template: m[1] !== undefined, condition: guardingCondition(m.index),
}))
const constraintNames = [...handWritten.matchAll(/ADD CONSTRAINT "(\w+)" CHECK/g)].map((m) => m[1])
const uniqueNames = [...handWritten.matchAll(/CREATE UNIQUE INDEX "(\w+)"/g)].map((m) => m[1]).concat(GENERATED_UNIQUE)

describe("migration 20261015400000: every hand-written rule is exercised by a real call shape", () => {
  it("finds the rules it checks", () => {
    expect(messages.length).toBeGreaterThan(70)
    expect(constraintNames.length).toBeGreaterThan(35)
    expect(uniqueNames.length).toBeGreaterThan(6)
    expect(suites.length).toBeGreaterThan(10)
  })

  it("every CHECK constraint is dropped by a refuses(...) rule", () => {
    expect(constraintNames.filter((n) => !evidence.constraints.has(n))).toEqual([])
  })

  it("every unique index is dropped by a refuses(...) rule", () => {
    expect(uniqueNames.filter((n) => !evidence.indexes.has(n))).toEqual([])
  })

  it("every RAISE message is removed by a raiseOff(...) or by a clauseOff(...) of its own statement", () => {
    const uncovered = messages.filter(({ text, template, condition }) => {
      if (evidence.raised.has(text)) return false
      const needle = template ? text.split("%s")[0] : text
      // a clause of the guarding IF (at least 15 characters, so no stray keyword stands for a rule)
      return !evidence.clauses.some((clause) => clause.includes(needle) || (squash(clause).length >= 15 && condition.includes(squash(clause).replace(/^IF /, "").replace(/ THEN$/, ""))))
    }).map((m) => m.text)
    expect(uncovered).toEqual([])
  })
})

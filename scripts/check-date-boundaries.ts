/**
 * Guard: no calendar boundary may be read or built in the process's LOCAL zone.
 *
 * The container sets no `TZ` — there is no `ENV TZ` in the Dockerfile, and
 * `instrumentation.ts` passes `timezone: SAST` to every `cron.schedule`
 * precisely because of that — so "local" is UTC while the business calendar is
 * SAST (fixed UTC+02:00, no DST). Anything built from local date parts lands up
 * to two hours inside the previous South African day. That put the same payment
 * in August in one place on the payments screen and July in another, moved days
 * in arrears (which drives collections escalation and the s.129 clock), and
 * wrote insurance premiums due on the 2nd.
 *
 * `lib/date/sast.ts` is the fix. This is what stops the fix being applied to
 * fourteen files and quietly missed on the fifteenth.
 *
 * ── Why this walks an AST rather than matching text ────────────────────────
 *
 * Four earlier versions of this file matched regexes against source text, and
 * every one of them was defeated. Not by anything exotic — by ordinary code:
 *
 *   `new Date(y, m, 1)` after `const y = now.getFullYear()` on another line;
 *   `copy.setMonth(d.getMonth() + 1); copy.setDate(0)`;
 *   `const [y, m] = [now.getFullYear(), now.getMonth()]`;
 *   `Date.UTC(y, m, 1)`;
 *   a duration shift in an unrelated nested arrow a few lines below;
 *   `d["getFullYear"]()`;
 *   a `"sast-exempt:"` STRING on the same line, silencing a real finding;
 *   one exemption comment covering two boundaries that shared a line;
 *   a `"use client"` directive quoted inside a block comment;
 *   and a docstring showing the anti-pattern, reported as a real finding.
 *
 * Those are not nine unrelated bugs. They are one bug: text cannot tell code
 * from a comment from a string, cannot resolve a computed member name, and
 * cannot attach an exemption to anything smaller than a line. The compiler can
 * do all three for free, and `typescript` is already a dependency.
 *
 * ── What is flagged ───────────────────────────────────────────────────────
 *
 *  1. Reading a local calendar part — `d.getFullYear()`, and the same call
 *     written `d["getMonth"]()`. Exempt only when the call is an argument to a
 *     `setX(...)` on the SAME receiver: `cutoff.setDate(cutoff.getDate() - 30)`
 *     shifts by a duration, preserves time of day, and is zone-independent.
 *     `x.setHours(y.getHours())` copies a wall-clock part between dates and is
 *     the bug, which is why the receiver has to match.
 *  2. The local calendar constructor — `new Date(y, m, d)` with two or more
 *     arguments. There is no correct server-side use of it here; SAST
 *     boundaries come from `lib/date/sast.ts`.
 *  3. `setHours(...)` at all, and `setDate` / `setMonth` / `setFullYear` whose
 *     arguments are not derived from a same-receiver getter.
 *  4. Formatting in the ambient zone — `toLocaleDateString` / `toLocaleString`
 *     / `toLocaleTimeString` without a `timeZone` option, `toDateString` /
 *     `toTimeString` (which cannot take one), and `Intl.DateTimeFormat`
 *     without `timeZone`. REPORTED, NOT BLOCKING — see the note at the bottom
 *     of this comment.
 *  5. `new Date("2026-08-20T00:00")` — a date-time literal with no offset is
 *     parsed as LOCAL time by specification.
 *
 * ── Exemptions ────────────────────────────────────────────────────────────
 *
 * `// sast-exempt: <reason>` on the node, or in the comment block above it, for
 * a use that is genuinely local-calendar. `// sast-pending:` marks a site that
 * IS wrong but is not being fixed in the current change: listed on every run,
 * never fails the build. The distinction matters — filing a known defect as
 * correct is how it stops being looked at.
 *
 * Both are read from real comment ranges via the scanner, so a marker inside a
 * string literal cannot silence anything, and both bind to a NODE, so one
 * marker cannot cover a second boundary that happens to share its line.
 *
 * ── Types, and why the program is built ───────────────────────────────────
 *
 * `x.toLocaleString("en-ZA")` is a date formatted in the ambient zone when `x`
 * is a Date, and ordinary money formatting when `x` is a number. Syntax cannot
 * tell them apart: without types this rule produced 87 findings of which 75
 * were `(cents / 100).toLocaleString(...)`. So the checker is asked. Building
 * the program costs about three seconds over ~1900 files, which is the price
 * of the rule being true.
 *
 * ── The formatter rule does not fail the build, yet ────────────────────────
 *
 * It is new, and it surfaces a class the boundary rules never saw: roughly
 * three dozen date formatters with no `timeZone`, across both server and
 * client code. Some are correct (a browser in Johannesburg IS in SAST); some
 * are the same two-hour defect in another costume. Triaging them is its own
 * change. Blocking on them today would either stall this one or invite three
 * dozen unconsidered exemptions, and an exemption written to make CI quiet is
 * worse than no rule. They are printed with a count on every run so the number
 * cannot quietly grow while nobody is looking.
 */
import { readdirSync, statSync } from "fs"
import { join, relative } from "path"
import ts from "typescript"

const ROOT = process.cwd()
const SCAN_DIRS = ["app", "lib", "components"]

/** Calendar parts that are read in the ambient zone. */
const LOCAL_GETTERS = new Set([
  "getFullYear", "getMonth", "getDate", "getDay", "getHours", "getMinutes",
])
const LOCAL_SETTERS = new Set(["setFullYear", "setMonth", "setDate", "setHours", "setMinutes"])
/** Formatters that resolve to the ambient zone unless told otherwise. */
const ZONELESS_FORMATTERS = new Set(["toLocaleDateString", "toLocaleString", "toLocaleTimeString"])
/** Formatters that cannot be given a zone at all. */
const UNZONEABLE_FORMATTERS = new Set(["toDateString", "toTimeString"])

const EXEMPT = /sast-exempt:\s*\S/
const PENDING = /sast-pending:\s*\S/

interface Finding {
  file: string
  line: number
  snippet: string
  reason: string
  pending: boolean
  /** Reported with a count, never fails the build. See the header. */
  advisory: boolean
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      yield* walk(full)
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) {
      yield full
    }
  }
}

/** Source text of the receiver a call is made on: `a.b.c` in `a.b.c.getDate()`. */
function receiverOf(call: ts.CallExpression, source: ts.SourceFile): string | null {
  const target = call.expression
  if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
    return target.expression.getText(source)
  }
  return null
}

/** The member name being called, whether written `d.getDate()` or `d["getDate"]()`. */
function memberName(call: ts.CallExpression): string | null {
  const target = call.expression
  if (ts.isPropertyAccessExpression(target)) return target.name.text
  if (ts.isElementAccessExpression(target)) {
    const arg = target.argumentExpression
    if (arg && ts.isStringLiteralLike(arg)) return arg.text
  }
  return null
}

/** True when an options argument names a timeZone. */
function hasTimeZone(args: readonly ts.Expression[]): boolean {
  return args.some(
    (arg) =>
      ts.isObjectLiteralExpression(arg) &&
      arg.properties.some((prop) => prop.name?.getText() === "timeZone"),
  )
}

/**
 * Markers on the node itself or in the comment block above it. Read through the
 * scanner's comment ranges, so only real comments count — a `"sast-exempt:"`
 * string literal on the same line is invisible here, which it was not before.
 */
function markers(node: ts.Node, source: ts.SourceFile): { exempt: boolean; pending: boolean } {
  const text = source.getFullText()
  const ranges = [
    ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
    ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
  ]
  // Also the comment block above the STATEMENT this node sits in: an exemption
  // is normally written above the line, not wedged inside the expression.
  let statement: ts.Node = node
  while (statement.parent && !ts.isStatement(statement)) statement = statement.parent
  if (statement !== node) {
    ranges.push(...(ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? []))
    ranges.push(...(ts.getTrailingCommentRanges(text, statement.getEnd()) ?? []))
  }
  const comments = ranges.map((range) => text.slice(range.pos, range.end)).join("\n")
  return { exempt: EXEMPT.test(comments), pending: PENDING.test(comments) }
}

function scan(source: ts.SourceFile, checker: ts.TypeChecker): Finding[] {
  const file = source.fileName
  const findings: Finding[] = []

  /** True when an expression is a Date, per the checker. */
  const isDate = (node: ts.Expression): boolean =>
    /\bDate\b/.test(checker.typeToString(checker.getTypeAtLocation(node)))

  const report = (node: ts.Node, reason: string, advisory = false) => {
    const { exempt, pending } = markers(node, source)
    if (exempt) return
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
    findings.push({
      file: relative(ROOT, file),
      line: line + 1,
      snippet: node.getText(source).replace(/\s+/g, " ").slice(0, 110),
      reason,
      pending,
      advisory,
    })
  }

  /**
   * A getter that is an argument to a `setX(...)` on the same receiver is a
   * duration shift. Collected before the walk so the check is a lookup rather
   * than a search upward through parents.
   */
  const durationShiftGetters = new Set<ts.Node>()
  const collectShifts = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = memberName(node)
      if (name && LOCAL_SETTERS.has(name)) {
        const target = receiverOf(node, source)
        for (const arg of node.arguments) {
          const markSameReceiver = (inner: ts.Node) => {
            if (
              ts.isCallExpression(inner) &&
              LOCAL_GETTERS.has(memberName(inner) ?? "") &&
              receiverOf(inner, source) === target
            ) {
              durationShiftGetters.add(inner)
            }
            ts.forEachChild(inner, markSameReceiver)
          }
          markSameReceiver(arg)
        }
      }
    }
    ts.forEachChild(node, collectShifts)
  }
  collectShifts(source)

  const visit = (node: ts.Node) => {
    // 1 — local calendar part read
    if (ts.isCallExpression(node)) {
      const name = memberName(node)

      if (name && LOCAL_GETTERS.has(name) && !durationShiftGetters.has(node)) {
        report(node, `${name}() reads the ambient zone`)
      }

      // 3 — local wall-clock write
      if (name && LOCAL_SETTERS.has(name)) {
        const shifting = node.arguments.some((arg) => {
          let found = false
          const look = (inner: ts.Node) => {
            if (
              ts.isCallExpression(inner) &&
              LOCAL_GETTERS.has(memberName(inner) ?? "") &&
              receiverOf(inner, source) === receiverOf(node, source)
            ) {
              found = true
            }
            ts.forEachChild(inner, look)
          }
          look(arg)
          return found
        })
        if (name === "setHours" || !shifting) {
          report(node, `${name}() writes an ambient-zone calendar boundary`)
        }
      }

      // 4 — formatting without a zone
      const formatted =
        ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression)
          ? node.expression.expression
          : undefined
      if (
        name &&
        ZONELESS_FORMATTERS.has(name) &&
        !hasTimeZone(node.arguments) &&
        formatted &&
        isDate(formatted)
      ) {
        report(node, `${name}() without a timeZone formats in the ambient zone`, true)
      }
      if (name && UNZONEABLE_FORMATTERS.has(name) && formatted && isDate(formatted)) {
        report(node, `${name}() cannot take a timeZone`, true)
      }
    }

    if (ts.isNewExpression(node)) {
      const callee = node.expression.getText(source)

      // 2 — the local calendar constructor
      if (callee === "Date" && (node.arguments?.length ?? 0) >= 2) {
        report(node, "new Date(y, m, …) builds a date in the ambient zone")
      }

      // 5 — a date-time literal with no offset parses as LOCAL time
      const only = node.arguments?.length === 1 ? node.arguments[0] : undefined
      if (
        callee === "Date" &&
        only &&
        ts.isStringLiteralLike(only) &&
        /T\d{2}:\d{2}/.test(only.text) &&
        !/(Z|[+-]\d{2}:?\d{2})$/.test(only.text)
      ) {
        report(node, "a date-time literal without an offset is parsed as local time")
      }

      // 4 — Intl without a zone
      if (callee === "Intl.DateTimeFormat" && !hasTimeZone(node.arguments ?? [])) {
        report(node, "Intl.DateTimeFormat without a timeZone uses the ambient zone", true)
      }
    }

    ts.forEachChild(node, visit)
  }
  visit(source)

  return findings
}

const config = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT)
const program = ts.createProgram(parsed.fileNames, parsed.options)
const checker = program.getTypeChecker()

const inScope = new Set(SCAN_DIRS.flatMap((dir) => [...walk(join(ROOT, dir))]))
const all = program
  .getSourceFiles()
  .filter((source) => !source.isDeclarationFile && inScope.has(source.fileName))
  .flatMap((source) => scan(source, checker))

const advisory = all.filter((f) => f.advisory)
const pending = all.filter((f) => !f.advisory && f.pending)
const findings = all.filter((f) => !f.advisory && !f.pending)

if (advisory.length > 0) {
  console.log(
    `ℹ ${advisory.length} date formatter${advisory.length === 1 ? "" : "s"} with no timeZone (advisory — see the header):`,
  )
  for (const f of advisory) console.log(`    ${f.file}:${f.line}  ${f.snippet}`)
  console.log("")
}

if (pending.length > 0) {
  console.log(
    `… ${pending.length} known ambient-zone boundar${pending.length === 1 ? "y" : "ies"} still pending a fix:`,
  )
  for (const f of pending) console.log(`    ${f.file}:${f.line}  ${f.snippet}`)
  console.log("")
}

if (findings.length === 0) {
  console.log("✓ no unmarked ambient-zone calendar boundaries")
  process.exit(0)
}

console.error(
  `\n✗ ${findings.length} ambient-zone calendar boundar${findings.length === 1 ? "y" : "ies"}.\n`,
)
for (const f of findings) {
  console.error(`  ${f.file}:${f.line} — ${f.reason}`)
  console.error(`    ${f.snippet}`)
}
console.error(`
  The container runs UTC (the Dockerfile sets no TZ); the business calendar is
  SAST. These resolve up to two hours inside the previous South African day.

  Use lib/date/sast.ts:

    const period = resolvePeriod({ period: "this-month" }, new Date())
    where: { receivedAt: periodFilter(period) }

  For a genuinely local-calendar use, say why:
    // sast-exempt: <why this is not a business-calendar boundary>
  For one that is wrong but not being fixed in this change:
    // sast-pending: <why it is deferred, and what it costs meanwhile>
`)
process.exit(1)

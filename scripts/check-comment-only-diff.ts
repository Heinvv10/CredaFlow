/**
 * Proves a change touched comments only.
 *
 *   npx tsx scripts/check-comment-only-diff.ts <base> [head]   # head defaults to the working tree
 *
 * For every changed .ts/.tsx/.mts/.mjs/.js file the TypeScript parser builds
 * the syntax tree of both versions — node kinds and token text, without
 * comments or whitespace (JSX text keeps the whitespace React renders) — and
 * the two must be identical; a comment that is a directive (@ts-expect-error,
 * eslint-disable, @vitest-environment, /// <reference>, #__PURE__, …) may not
 * change at all. .css/.sql/.prisma files are compared with comments removed
 * and whitespace runs collapsed, string contents untouched. For .yml/.yaml/.sh
 * files every added or removed line must be blank or a whole-line comment (a
 * `#` line inside a heredoc or YAML block scalar is content this cannot tell
 * apart — check those by eye); scripts/integration-baseline.txt is checked
 * line by line, its `#` lines being comments. Any other changed file, an added,
 * deleted or (working-tree mode) untracked file, a rename and a mode change are
 * reported. Exits 1 when anything is reported.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import ts from "typescript"

const CODE = /\.(ts|tsx|mts|mjs|js)$/
/** Files compared with their comments stripped, by comment syntax. */
const STRIP: Record<string, { line?: string; block?: boolean; backslash: boolean }> = {
  css: { block: true, backslash: true },
  sql: { line: "--", block: true, backslash: false },
  prisma: { line: "//", backslash: true },
}
/** Comments that change what a tool does, not just what a reader reads. */
const DIRECTIVE = /@ts-(ignore|expect-error|nocheck|check)|eslint-(disable|enable)|(vitest|jest)-environment|<reference\b|[@#]__(PURE|NO_SIDE_EFFECTS)__|(istanbul|c8|v8) ignore|prettier-ignore|biome-ignore|webpack[A-Z]|@jsx(Runtime|ImportSource|Frag)?\b|@license|@preserve/
/** Files with `#` comment lines whose extension says nothing about it. */
const LINE_COMMENT_FILES: Record<string, RegExp> = {
  "integration-baseline.txt": /^\s*(#.*)?$/,
}
const LINE_COMMENT: Record<string, RegExp> = {
  yml: /^\s*(#.*)?$/,
  yaml: /^\s*(#.*)?$/,
  sh: /^\s*(#(?!!).*)?$/,
}

/**
 * JSX text as React renders it: whitespace that contains a line break is
 * dropped, the rest of each line is kept, and lines join with one space.
 */
function jsxText(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/)
  return lines
    .map((line, i) => {
      let l = line.replace(/\t/g, " ")
      if (i > 0) l = l.replace(/^ +/, "")
      if (i < lines.length - 1) l = l.replace(/ +$/, "")
      return l
    })
    .filter(Boolean)
    .join(" ")
}

const parse = (source: string, fileName: string) =>
  ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : /\.(js|mjs)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS)

/** The syntax tree as a list: `(Kind` / `)` around every node, `Kind text` for every token. */
export function tokens(source: string, fileName: string): string[] {
  const file = parse(source, fileName)
  const out: string[] = []
  const visit = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return
    const children = node.getChildren(file)
    if (children.length === 0) {
      if (node.kind === ts.SyntaxKind.EndOfFileToken) return
      // getText() drops a JSX text's leading whitespace as trivia; React renders it.
      const text = node.kind === ts.SyntaxKind.JsxText ? jsxText(node.getFullText(file)) : node.getText(file)
      if (node.kind !== ts.SyntaxKind.JsxText || text !== "") out.push(`${ts.SyntaxKind[node.kind]} ${text}`)
      return
    }
    out.push(`(${ts.SyntaxKind[node.kind]}`)
    children.forEach(visit)
    out.push(")")
  }
  visit(file)
  return out
}

/** Every directive comment in the source (and a leading #! line), in order. */
export function directives(source: string, fileName: string): string[] {
  const file = parse(source, fileName)
  const seen = new Set<number>()
  const out: string[] = source.startsWith("#!") ? [source.split("\n")[0]] : []
  const visit = (node: ts.Node) => {
    for (const r of [...(ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []), ...(ts.getTrailingCommentRanges(source, node.getEnd()) ?? [])]) {
      if (seen.has(r.pos)) continue
      seen.add(r.pos)
      const text = source.slice(r.pos, r.end)
      if (DIRECTIVE.test(text)) out.push(text)
    }
    node.getChildren(file).forEach(visit)
  }
  visit(file)
  return out.sort()
}

/** Why `head` is not a comment-only change of `base` (a code file), or null when it is. */
export function codeDifference(base: string, head: string, fileName: string): string | null {
  const da = directives(base, fileName), db = directives(head, fileName)
  if (da.join("\n") !== db.join("\n")) return `a directive comment changed: ${da.find((d) => !db.includes(d)) ?? db.find((d) => !da.includes(d))}`
  const a = tokens(base, fileName), b = tokens(head, fileName)
  const i = a.findIndex((t, n) => t !== b[n])
  if (i === -1 && a.length === b.length) return null
  const at = i === -1 ? Math.min(a.length, b.length) : i
  return `token ${at}: ${a[at] ?? "<end>"} -> ${b[at] ?? "<end>"}`
}

/** The source without comments, whitespace runs collapsed to one space; strings kept as written. */
export function stripComments(source: string, fileName: string): string {
  const syntax = STRIP[fileName.split(".").pop() ?? ""]
  let out = ""
  let i = 0
  while (i < source.length) {
    const c = source[i]
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < source.length && source[j] !== c) j += syntax.backslash && source[j] === "\\" ? 2 : 1
      out += source.slice(i, j + 1)
      i = j + 1
    } else if (syntax.block && source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2)
      out += " "
      i = end < 0 ? source.length : end + 2
    } else if (syntax.line && source.startsWith(syntax.line, i)) {
      const end = source.indexOf("\n", i)
      i = end < 0 ? source.length : end
    } else if (/\s/.test(c)) {
      while (i < source.length && /\s/.test(source[i])) i++
      out += " "
    } else {
      out += c
      i++
    }
  }
  return out.replace(/ {2,}/g, " ").trim()
}

/** Why `head` differs from `base` other than in comments and whitespace (css/sql/prisma), or null. */
export function strippedDifference(base: string, head: string, fileName: string): string | null {
  const a = stripComments(base, fileName), b = stripComments(head, fileName)
  if (a === b) return null
  let i = 0
  while (a[i] === b[i]) i++
  return `code differs at: ${a.slice(Math.max(0, i - 30), i + 30)} -> ${b.slice(Math.max(0, i - 30), i + 30)}`
}

/** The first added/removed line of a `git diff -U0` that is not blank or a whole-line comment. */
export function nonCommentLine(unifiedDiff: string, fileName: string): string | null {
  const comment = LINE_COMMENT_FILES[fileName.split("/").pop() ?? ""] ?? LINE_COMMENT[fileName.split(".").pop() ?? ""]
  if (!comment) return "this checker cannot prove this file type"
  let inHunk = false
  for (const line of unifiedDiff.split("\n")) {
    if (line.startsWith("@@")) inHunk = true
    if (!inHunk || !/^[+-]/.test(line)) continue
    if (!comment.test(line.slice(1))) return `non-comment line changed: ${line}`
  }
  return null
}

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 })

function main(base: string, head?: string) {
  const range = head ? [base, head] : [base]
  const status = git("diff", "--name-status", "--no-renames", ...range).trim().split("\n").filter(Boolean)
  const problems: string[] = []
  for (const m of git("diff", "--summary", "--no-renames", ...range).matchAll(/mode change \d+ => \d+ (.+)/g)) problems.push(`${m[1]}: mode changed`)
  if (!head) for (const f of git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean)) problems.push(`${f}: untracked`)
  let checked = 0
  for (const line of status) {
    const [state, file] = line.split("\t")
    if (state !== "M") {
      problems.push(`${file}: ${state === "A" ? "added" : state === "D" ? "deleted" : state}`)
      continue
    }
    const ext = file.split(".").pop() ?? ""
    const before = () => git("show", `${base}:${file}`)
    const after = () => (head ? git("show", `${head}:${file}`) : readFileSync(file, "utf8"))
    const why = CODE.test(file)
      ? codeDifference(before(), after(), file)
      : STRIP[ext]
        ? strippedDifference(before(), after(), file)
        : nonCommentLine(git("diff", "-U0", ...range, "--", file), file)
    checked++
    if (why) problems.push(`${file}: ${why}`)
  }
  for (const p of problems) console.error(p)
  console.log(`${checked} changed files checked, ${problems.length} not comment-only`)
  process.exit(problems.length ? 1 : 0)
}

if (process.argv[1]?.endsWith("check-comment-only-diff.ts")) {
  if (!process.argv[2]) {
    console.error("usage: npx tsx scripts/check-comment-only-diff.ts <base> [head]")
    process.exit(2)
  }
  main(process.argv[2], process.argv[3])
}

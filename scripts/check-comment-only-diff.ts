/**
 * Proves a change touched comments only.
 *
 *   npx tsx scripts/check-comment-only-diff.ts <base> [head]   # head defaults to the working tree
 *
 * For every changed .ts/.tsx/.mts/.mjs/.js file the TypeScript parser builds
 * the token stream of both versions without comments or whitespace; the two
 * must be identical. .css/.sql/.prisma files are compared with their comments
 * and all whitespace removed. For .yml/.yaml/.sh files every added or removed
 * line must be blank or a whole-line comment. Any other changed file, an added
 * or deleted file, or a rename is reported. Exits 1 when anything is reported.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import ts from "typescript"

const CODE = /\.(ts|tsx|mts|mjs|js)$/
/** Comment syntax of the files compared with their comments stripped. */
const STRIP: Record<string, RegExp> = {
  css: /\/\*[\s\S]*?\*\//g,
  sql: /--[^\n]*/g,
  prisma: /\/\/[^\n]*/g,
}
const LINE_COMMENT: Record<string, RegExp> = {
  yml: /^\s*(#.*)?$/,
  yaml: /^\s*(#.*)?$/,
  sh: /^\s*(#(?!!).*)?$/,
}

/** The source's tokens, kind and text, with comments and whitespace dropped. */
export function tokens(source: string, fileName: string): string[] {
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : /\.(js|mjs)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const out: string[] = []
  const visit = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return
    const children = node.getChildren(file)
    if (children.length === 0) {
      if (node.kind === ts.SyntaxKind.EndOfFileToken) return
      // JSX text is content; only its whitespace layout is free to change.
      const text = node.kind === ts.SyntaxKind.JsxText ? node.getText(file).replace(/\s+/g, " ").trim() : node.getText(file)
      if (node.kind !== ts.SyntaxKind.JsxText || text !== "") out.push(`${ts.SyntaxKind[node.kind]} ${text}`)
      return
    }
    children.forEach(visit)
  }
  visit(file)
  return out
}

/** Why `head` is not a comment-only change of `base` (a code file), or null when it is. */
export function codeDifference(base: string, head: string, fileName: string): string | null {
  const a = tokens(base, fileName), b = tokens(head, fileName)
  const i = a.findIndex((t, n) => t !== b[n])
  if (i === -1 && a.length === b.length) return null
  const at = i === -1 ? Math.min(a.length, b.length) : i
  return `token ${at}: ${a[at] ?? "<end>"} -> ${b[at] ?? "<end>"}`
}

/** Why `head` differs from `base` other than in comments and whitespace (css/sql/prisma), or null. */
export function strippedDifference(base: string, head: string, fileName: string): string | null {
  const re = STRIP[fileName.split(".").pop() ?? ""]
  const bare = (s: string) => s.replace(re, "").replace(/\s+/g, "")
  const a = bare(base), b = bare(head)
  if (a === b) return null
  let i = 0
  while (a[i] === b[i]) i++
  return `code differs at: ${a.slice(Math.max(0, i - 30), i + 30)} -> ${b.slice(Math.max(0, i - 30), i + 30)}`
}

/** The first added/removed line of a `git diff -U0` that is not blank or a whole-line comment. */
export function nonCommentLine(unifiedDiff: string, fileName: string): string | null {
  const comment = LINE_COMMENT[fileName.split(".").pop() ?? ""]
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

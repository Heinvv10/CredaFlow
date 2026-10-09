import { describe, expect, it } from "vitest"
import { codeDifference, nonCommentLine, strippedDifference } from "../check-comment-only-diff"

const TS = `// The 2026-07-28 incident.
/** Refuses a stale quote. */
export function f(a: number) {
  return a + 1 // count
}
`

describe("codeDifference", () => {
  it("accepts a change to comments and whitespace only", () => {
    const head = TS.replace("// The 2026-07-28 incident.", "// Refused because a stale quote misprices.")
      .replace("/** Refuses a stale quote. */", "/**\n * Refuses a quote older than its validity.\n */")
      .replace("return a + 1 // count", "return  a + 1")
    expect(codeDifference(TS, head, "f.ts")).toBeNull()
  })

  it("reports a code change", () => {
    expect(codeDifference(TS, TS.replace("a + 1", "a + 2"), "f.ts")).toMatch(/ 1 -> \S+ 2$/)
  })

  it("reports a string literal change, including one that looks like a comment", () => {
    const src = `const u = "http://x.invalid/a"\n`
    expect(codeDifference(src, src.replace("/a", "/b"), "u.ts")).not.toBeNull()
  })

  it("reports JSX text, but not a JSX comment", () => {
    const tsx = `export const A = () => <p>{/* old note */}Pay by the 1st // not a comment</p>\n`
    expect(codeDifference(tsx, tsx.replace("old note", "new note"), "a.tsx")).toBeNull()
    expect(codeDifference(tsx, tsx.replace("1st", "2nd"), "a.tsx")).toMatch(/JsxText/)
    expect(codeDifference(tsx, tsx.replace("// not a comment", "// still text"), "a.tsx")).toMatch(/JsxText/)
  })

  it("reports a removed token", () => {
    expect(codeDifference("f(1, 2)\n", "f(1)\n", "g.mjs")).not.toBeNull()
  })
})

describe("strippedDifference", () => {
  it("accepts comment and whitespace changes in CSS, SQL and Prisma", () => {
    expect(strippedDifference("a { color: red; } /* old */", "/* new\n * more */\na {\n  color: red;\n}", "a.css")).toBeNull()
    expect(strippedDifference("SELECT 1; -- old", "-- new\nSELECT 1;", "m.sql")).toBeNull()
    expect(strippedDifference("model A {\n  id String // old\n}", "/// new\nmodel A {\n  id String\n}", "schema.prisma")).toBeNull()
  })

  it("reports a code change", () => {
    expect(strippedDifference("a { color: red; }", "a { color: blue; }", "a.css")).toMatch(/red.*blue/)
    expect(strippedDifference("SELECT 1;", "SELECT 2;", "m.sql")).not.toBeNull()
    expect(strippedDifference("model A {\n  id String\n}", "model A {\n  id Int\n}", "schema.prisma")).not.toBeNull()
  })
})

describe("nonCommentLine", () => {
  const diff = (lines: string) => `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n${lines}\n`

  it("accepts comment-only YAML and shell changes", () => {
    expect(nonCommentLine(diff("-# old\n+# new\n+"), "w.yml")).toBeNull()
    expect(nonCommentLine(diff("-# old\n+# new"), "r.sh")).toBeNull()
  })

  it("reports a changed code line", () => {
    expect(nonCommentLine(diff("-run: a\n+run: b"), "w.yml")).toMatch(/run/)
    expect(nonCommentLine(diff("+#!/bin/sh"), "r.sh")).toMatch(/#!/)
  })

  it("reads the integration baseline's # lines as comments, and its entries as code", () => {
    expect(nonCommentLine(diff("-# old\n+# new"), "scripts/integration-baseline.txt")).toBeNull()
    expect(nonCommentLine(diff("+lib/a.integration.test.ts"), "scripts/integration-baseline.txt")).toMatch(/lib\/a/)
  })

  it("refuses a file type it cannot prove", () => {
    expect(nonCommentLine(diff("+x"), "README.md")).toMatch(/cannot prove/)
  })
})

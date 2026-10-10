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

  it("reports a comment edit that changes automatic semicolon insertion", () => {
    expect(codeDifference("function f() { return /* a\n b */ 1 }\n", "function f() { return /* a b */ 1 }\n", "f.ts")).not.toBeNull()
    expect(codeDifference("function f() { return // why\n 1 }\n", "function f() { return 1 }\n", "f.ts")).not.toBeNull()
    expect(codeDifference("a++\nb\n", "a\n++b\n", "f.ts")).not.toBeNull()
  })

  it("reports any change to a directive comment", () => {
    expect(codeDifference("// @ts-expect-error old\nx()\n", "// note\nx()\n", "f.ts")).toMatch(/directive/)
    expect(codeDifference("// @vitest-environment jsdom\nx()\n", "x()\n", "f.test.ts")).toMatch(/directive/)
    expect(codeDifference("/* eslint-disable no-console */\nx()\n", "/* eslint-disable no-debugger */\nx()\n", "f.ts")).toMatch(/directive/)
    expect(codeDifference("const a = /*#__PURE__*/ f()\n", "const a = f()\n", "f.ts")).toMatch(/directive/)
    // Prose around an unchanged directive line may change.
    expect(codeDifference("/**\n * Old reason.\n * @vitest-environment jsdom\n */\nx()\n", "/**\n * New reason.\n * @vitest-environment jsdom\n */\nx()\n", "f.test.ts")).toBeNull()
  })

  it("keeps JSX whitespace React renders, drops what it does not", () => {
    expect(codeDifference("const a = <p><b>x</b> hello</p>\n", "const a = <p><b>x</b>hello</p>\n", "a.tsx")).not.toBeNull()
    expect(codeDifference("const a = <p>\n  hello\n</p>\n", "const a = <p>\n      hello\n</p>\n", "a.tsx")).toBeNull()
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

  it("leaves string contents alone, even when they look like comments", () => {
    expect(strippedDifference('model A {\n  u String @default("https://a.example")\n}', 'model A {\n  u String @default("https://b.example")\n}', "schema.prisma")).not.toBeNull()
    expect(strippedDifference("SELECT '--a', 1;", "SELECT '--b', 2;", "m.sql")).not.toBeNull()
    expect(strippedDifference('a::before { content: "/*"; color: red } b { content: "*/" }', 'a::before { content: "/*"; color: blue } b { content: "*/" }', "a.css")).not.toBeNull()
    expect(strippedDifference("SELECT 'a b';", "SELECT 'ab';", "m.sql")).not.toBeNull()
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

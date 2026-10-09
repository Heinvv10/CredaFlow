import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { TOKEN_SHEETS, definedTokens, duplicateSelectorLines, undefinedUses, usedTokens } from "../css-vars"

const root = process.cwd()
const sheets = TOKEN_SHEETS.map((s) => readFileSync(join(root, s), "utf8"))

describe("--cf-* tokens", () => {
  it("every var(--cf-…) without a fallback is defined in a token stylesheet", () => {
    expect(undefinedUses(root, sheets)).toEqual([])
  })

  it("reports a use once its definition is removed", () => {
    const withoutText = sheets.map((css) => css.replace(/--cf-text\s*:[^;]*;/g, ""))
    expect(undefinedUses(root, withoutText).some((l) => l.endsWith(": --cf-text"))).toBe(true)
  })

  it("skips uses with a fallback and reads definitions, not uses", () => {
    expect(usedTokens("a { color: var(--cf-x); b: var(--cf-y, red); c: var( --cf-z ) }")).toEqual(["--cf-x", "--cf-z"])
    expect([...definedTokens(":root { --cf-a: 1px; color: var(--cf-b); }")]).toEqual(["--cf-a"])
  })

  it("no rule repeats a selector line", () => {
    expect(sheets.flatMap(duplicateSelectorLines)).toEqual([])
    expect(duplicateSelectorLines(".a,\n.b,\n.a {\n}\n:is(\n  [x],\n  [x]\n) {}")).toEqual([".a", "[x]"])
  })
})

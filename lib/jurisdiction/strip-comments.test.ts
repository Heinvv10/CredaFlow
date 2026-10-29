import { describe, expect, it } from "vitest"
import { stripComments } from "./strip-comments"

describe("stripComments", () => {
  it("drops line and block comments but keeps code", () => {
    expect(stripComments("a() // ncaOnlyRefusal(\n/* ncaOnlyRefusal( */ b()")).not.toContain("ncaOnlyRefusal")
    expect(stripComments("a() // x\nb()")).toContain("b()")
  })
  it("keeps a // or /* inside a string or template", () => {
    expect(stripComments('const u = "http://x/*y"; ncaOnlyRefusal(1)')).toContain("ncaOnlyRefusal(1)")
    expect(stripComments("const t = `// ${x}`; go()")).toContain("go()")
  })
  it("survives an unterminated block comment", () => {
    expect(stripComments("a() /* never closed")).toBe("a()  ")
  })
})

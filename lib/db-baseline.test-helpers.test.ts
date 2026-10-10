import fs from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"

type Helpers = typeof import("./db-baseline.test-helpers")

/** Load a fresh copy of the helper reading `migrations` (dir name -> SQL) instead of prisma/migrations. */
async function load(migrations: Record<string, string>): Promise<Helpers> {
  const sqlOf = (p: unknown) => {
    const [dir] = String(p).split("/").slice(-2)
    return migrations[dir]
  }
  vi.resetModules()
  vi.spyOn(fs, "readdirSync").mockImplementation((() => Object.keys(migrations)) as never)
  vi.spyOn(fs, "existsSync").mockImplementation(((p: unknown) => sqlOf(p) !== undefined) as never)
  vi.spyOn(fs, "readFileSync").mockImplementation(((p: unknown) => sqlOf(p)) as never)
  return import("./db-baseline.test-helpers")
}

const fn = (head: string, body = "SELECT 1") =>
  `${head} RETURNS trigger LANGUAGE plpgsql AS $function$\nBEGIN ${body}; END\n$function$;\n`

afterEach(() => vi.restoreAllMocks())

describe("baselineFunctionSql", () => {
  it("reads a multi-line header, extra whitespace, and an unqualified name", async () => {
    const h = await load({
      "1_a": fn(`CREATE OR REPLACE FUNCTION public."f1"()`, "OLD"),
      "2_b": [
        fn(`CREATE OR REPLACE FUNCTION\n  public."f1"()`, "NEW1"),
        fn(`CREATE   OR REPLACE\n\tFUNCTION "f2"()`, "NEW2"),
        fn(`CREATE OR REPLACE FUNCTION f3()`, "NEW3"),
      ].join("\n"),
    })
    expect(h.baselineFunctionSql("f1")).toContain("NEW1")
    expect(h.baselineFunctionSql("f2")).toContain("NEW2")
    expect(h.baselineFunctionSql("f3")).toContain("NEW3")
  })

  it("treats a multi-line or unqualified DROP as the latest word", async () => {
    const h = await load({
      "1_a": fn(`CREATE OR REPLACE FUNCTION public."f1"()`) + fn(`CREATE OR REPLACE FUNCTION public."f2"()`),
      "2_b": `DROP FUNCTION IF EXISTS\n  public."f1"();\nDROP FUNCTION "f2"();\n`,
    })
    expect(() => h.baselineFunctionSql("f1")).toThrow(/dropped by 2_b/)
    expect(() => h.baselineFunctionSql("f2")).toThrow(/dropped by 2_b/)
  })

  it("does not match an unquoted name for a mixed-case function", async () => {
    const h = await load({
      "1_a": fn(`CREATE OR REPLACE FUNCTION public."Foo"()`, "UPPER"),
      "2_b": fn(`CREATE OR REPLACE FUNCTION foo()`, "LOWER"),
    })
    expect(h.baselineFunctionSql("Foo")).toContain("UPPER")
    expect(h.baselineFunctionSql("foo")).toContain("LOWER")
  })
})

describe("baselineTriggerSql", () => {
  it("reads CREATE [OR REPLACE] TRIGGER across lines, qualified or not", async () => {
    const h = await load({
      "1_a": `CREATE TRIGGER "t1" BEFORE INSERT ON public."T" FOR EACH ROW EXECUTE FUNCTION public."f"();\n`,
      "2_b":
        `CREATE OR REPLACE TRIGGER\n  "t1"\n  BEFORE UPDATE ON "T"\n  FOR EACH ROW\n  EXECUTE FUNCTION f();\n` +
        `CREATE CONSTRAINT TRIGGER t2 AFTER INSERT ON public."T" DEFERRABLE FOR EACH ROW EXECUTE FUNCTION f();\n`,
    })
    expect(h.baselineTriggerSql("t1")).toMatch(/BEFORE UPDATE ON "T"\s+FOR EACH ROW\s+EXECUTE FUNCTION f\(\);$/)
    expect(h.baselineTriggerSql("t2")).toContain("AFTER INSERT")
  })

  it("honours a multi-line DROP TRIGGER", async () => {
    const h = await load({
      "1_a": `CREATE TRIGGER "t1" BEFORE INSERT ON public."T" FOR EACH ROW EXECUTE FUNCTION f();\n`,
      "2_b": `DROP TRIGGER IF EXISTS\n "t1" ON public."T";\n`,
    })
    expect(() => h.baselineTriggerSql("t1")).toThrow(/dropped by 2_b/)
  })

  it("keeps a semicolon inside a string literal in the statement", async () => {
    const h = await load({
      "1_a": `CREATE TRIGGER "t1" BEFORE INSERT ON "T" FOR EACH ROW WHEN (NEW.a = 'x;y')\n EXECUTE FUNCTION f();\n`,
    })
    expect(h.baselineTriggerSql("t1")).toMatch(/'x;y'\)\s+EXECUTE FUNCTION f\(\);$/)
  })

  it("does not match an unquoted name for a mixed-case trigger", async () => {
    const h = await load({ "1_a": `CREATE TRIGGER foo BEFORE INSERT ON "T" FOR EACH ROW EXECUTE FUNCTION f();\n` })
    expect(() => h.baselineTriggerSql("Foo")).toThrow(/found 0/)
    expect(h.baselineTriggerSql("foo")).toContain("BEFORE INSERT")
  })
})

describe("baselineIndexSql", () => {
  it("reads multi-line, qualified and unquoted CREATE INDEX, and a multi-line DROP", async () => {
    const h = await load({
      "1_a": `CREATE UNIQUE INDEX "i1" ON public."T"("a");\nCREATE INDEX "i2" ON "T"("a");\n`,
      "2_b": `CREATE INDEX\n  IF NOT EXISTS public.i3\n  ON "T"("b");\nDROP INDEX IF EXISTS\n  public."i2";\n`,
    })
    expect(h.baselineIndexSql("i1")).toContain("UNIQUE")
    expect(h.baselineIndexSql("i3")).toContain(`ON "T"("b");`)
    expect(() => h.baselineIndexSql("i2")).toThrow(/dropped by 2_b/)
  })
})

describe("baselineConstraintSql", () => {
  it("reads multi-line ADD and unqualified/ONLY/multi-line DROP CONSTRAINT", async () => {
    const h = await load({
      "1_a": `ALTER TABLE "T" ADD CONSTRAINT "c1" CHECK (a > 0);\nALTER TABLE "T" ADD CONSTRAINT "c2" CHECK (a > 0);\n`,
      "2_b":
        `ALTER TABLE ONLY public."T"\n  ADD CONSTRAINT "c1"\n  CHECK (a > 1);\n` +
        `ALTER TABLE public."T"\n  DROP CONSTRAINT IF EXISTS\n  "c2";\n`,
    })
    expect(h.baselineConstraintSql("c1")).toContain("a > 1")
    expect(() => h.baselineConstraintSql("c2")).toThrow(/dropped by 2_b/)
  })
})

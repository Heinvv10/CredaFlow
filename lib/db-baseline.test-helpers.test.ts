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

describe("SQL-aware scanning", () => {
  it("ends a trigger at its own semicolon despite an apostrophe in a comment", async () => {
    const h = await load({
      "1_a":
        `CREATE TRIGGER "t1" BEFORE INSERT ON "T"\n  -- don't fire on bulk\n  FOR EACH ROW EXECUTE FUNCTION f();\n` +
        `CREATE TRIGGER "t2" AFTER UPDATE ON "T" FOR EACH ROW EXECUTE FUNCTION g();\n-- that's all\nSELECT 1;\n`,
    })
    const t1 = h.baselineTriggerSql("t1")
    expect(t1).toMatch(/EXECUTE FUNCTION f\(\);$/)
    expect(t1).not.toContain("t2")
  })

  it("ends a $$ function at its own close, not at a later $function$ one", async () => {
    const h = await load({
      "1_a":
        `CREATE OR REPLACE FUNCTION g() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;\n` +
        fn(`CREATE OR REPLACE FUNCTION public."other"()`, "RAISE EXCEPTION 'x'"),
    })
    const g = h.baselineFunctionSql("g")
    expect(g).toMatch(/END \$\$ LANGUAGE plpgsql;$/)
    expect(g).not.toContain("RAISE")
  })

  it("ends a $function$ function that closes with a trailing clause", async () => {
    const h = await load({
      "1_a":
        `CREATE OR REPLACE FUNCTION f1() RETURNS trigger AS $function$ BEGIN RETURN NEW; END $function$ LANGUAGE plpgsql;\n` +
        `CREATE OR REPLACE FUNCTION f2() RETURNS int AS $function$ SELECT 2 $function$ LANGUAGE sql;\n`,
    })
    expect(h.baselineFunctionSql("f1")).not.toContain("SELECT 2")
    expect(h.baselineFunctionSql("f2")).toContain("SELECT 2")
  })

  it("does not read a DROP inside a function body or a comment as a drop", async () => {
    const h = await load({
      "1_a": `CREATE INDEX "i1" ON "T"("a");\nCREATE INDEX "i2" ON "T"("a");\n`,
      "2_b":
        fn(`CREATE OR REPLACE FUNCTION f()`, "\n  DROP INDEX IF EXISTS \"i1\";\n") +
        `/* outer /* nested */ DROP INDEX "i2"; */\n-- DROP INDEX "i2";\nSELECT 'x'; DROP TABLE "z";\n`,
    })
    expect(h.baselineIndexSql("i1")).toContain("CREATE INDEX")
    expect(h.baselineIndexSql("i2")).toContain("CREATE INDEX")
  })

  it("does not read a CREATE inside a comment or string as a definition", async () => {
    const h = await load({
      "1_a": `CREATE INDEX "i1" ON "T"("a");\n`,
      "2_b": `-- CREATE INDEX "i1" ON "T"("b");\nSELECT E'it\\'s; CREATE INDEX "i1" ON "T"("c");';\nSELECT "a;b";\n`,
    })
    expect(h.baselineIndexSql("i1")).toContain(`("a")`)
  })

  it("handles tagged dollar quotes, E strings and doubled quotes", async () => {
    const h = await load({
      "1_a": `CREATE TRIGGER "t1" BEFORE INSERT ON "T" FOR EACH ROW WHEN (NEW.a = E'a\\';b' OR NEW."x;""y" = 'it''s;') EXECUTE FUNCTION f();\n`,
      "2_b": `CREATE OR REPLACE FUNCTION h() RETURNS int AS $body$ SELECT $$;$$; $body$ LANGUAGE sql;\n`,
    })
    expect(h.baselineTriggerSql("t1")).toMatch(/EXECUTE FUNCTION f\(\);$/)
    expect(h.baselineFunctionSql("h")).toMatch(/LANGUAGE sql;$/)
  })
})

describe("ALTER TABLE grammar and lists", () => {
  it("accepts IF EXISTS before ONLY and rejects ONLY before IF EXISTS", async () => {
    const h = await load({
      "1_a": `ALTER TABLE "T" ADD CONSTRAINT "c1" CHECK (a > 0);\nALTER TABLE "T" ADD CONSTRAINT "c2" CHECK (a > 0);\n`,
      "2_b": `ALTER TABLE IF EXISTS ONLY "T" DROP CONSTRAINT "c1";\nALTER TABLE ONLY IF EXISTS "T" DROP CONSTRAINT "c2";\n`,
    })
    expect(() => h.baselineConstraintSql("c1")).toThrow(/dropped by 2_b/)
    expect(h.baselineConstraintSql("c2")).toContain("a > 0")
  })

  it("treats an unquoted table name case-insensitively", async () => {
    const h = await load({
      "1_a": `ALTER TABLE "T" ADD CONSTRAINT "c1" CHECK (a > 0);\n`,
      "2_b": `alter table Public.MyTable drop constraint c1;\n`,
    })
    expect(() => h.baselineConstraintSql("c1")).toThrow(/dropped by 2_b/)
  })

  it("counts every object of a multi-object DROP", async () => {
    const h = await load({
      "1_a": fn(`CREATE OR REPLACE FUNCTION f1()`) + `CREATE INDEX "i1" ON "T"("a");\nCREATE INDEX "i2" ON "T"("a");\n`,
      "2_b": `DROP FUNCTION a(), f1();\nDROP INDEX "i1", public."i2";\n`,
    })
    expect(() => h.baselineFunctionSql("f1")).toThrow(/dropped by 2_b/)
    expect(() => h.baselineIndexSql("i1")).toThrow(/dropped by 2_b/)
    expect(() => h.baselineIndexSql("i2")).toThrow(/dropped by 2_b/)
  })

  it("counts a DROP CONSTRAINT after an ADD in one ALTER TABLE", async () => {
    const h = await load({
      "1_a": `ALTER TABLE "T" ADD CONSTRAINT "c1" CHECK (a > 0);\n`,
      "2_b": `ALTER TABLE "T" ADD CONSTRAINT "c9" CHECK (b > 0),\n DROP CONSTRAINT "c1";\n`,
    })
    expect(() => h.baselineConstraintSql("c1")).toThrow(/dropped by 2_b/)
    expect(h.baselineConstraintSql("c9")).toContain("b > 0")
  })

  it("returns the ADD of an atomic DROP then ADD, splitting only on top-level commas", async () => {
    const h = await load({
      "1_a": `ALTER TABLE "T" ADD CONSTRAINT "c1" CHECK (a > 0);\n`,
      "2_b": `ALTER TABLE "T" DROP CONSTRAINT "c1", ADD CONSTRAINT "c1" CHECK (a IN (1, 2) AND b <> 'x,y');\n`,
    })
    const c1 = h.baselineConstraintSql("c1")
    expect(c1).toContain("a IN (1, 2)")
  })

  it("does not take a column default comma for an action boundary", async () => {
    const h = await load({
      "1_a": `ALTER TABLE "T" ADD CONSTRAINT "c1" CHECK (a > 0);\n`,
      "2_b": `ALTER TABLE "T" ADD CONSTRAINT "c2" CHECK (f(1, 'DROP CONSTRAINT "c1"') > 0);\n`,
    })
    expect(h.baselineConstraintSql("c1")).toContain("a > 0")
  })
})

describe("CREATE forms and unqualified coverage", () => {
  it("counts a plain CREATE FUNCTION and CREATE OR REPLACE TRIGGER after a drop", async () => {
    const h = await load({
      "1_a": fn(`CREATE OR REPLACE FUNCTION f1()`, "OLD") + `CREATE TRIGGER "t1" BEFORE INSERT ON "T" FOR EACH ROW EXECUTE FUNCTION f();\n`,
      "2_b": `DROP FUNCTION f1();\n` + fn(`CREATE FUNCTION f1()`, "NEW") + `DROP TRIGGER "t1" ON "T";\nCREATE OR REPLACE TRIGGER "t1" AFTER INSERT ON "T" FOR EACH ROW EXECUTE FUNCTION f();\n`,
    })
    expect(h.baselineFunctionSql("f1")).toContain("NEW")
    expect(h.baselineTriggerSql("t1")).toContain("AFTER INSERT")
  })

  it("honours an unqualified DROP INDEX, unqualified-table DROP CONSTRAINT, and unquoted schemaless CREATE INDEX", async () => {
    const h = await load({
      "1_a": `CREATE INDEX "i1" ON "T"("a");\nCREATE INDEX i2 ON "T"("a");\nALTER TABLE "T" ADD CONSTRAINT "c1" CHECK (a > 0);\n`,
      "2_b": `DROP INDEX "i1";\nALTER TABLE "T" DROP CONSTRAINT "c1";\n`,
    })
    expect(() => h.baselineIndexSql("i1")).toThrow(/dropped by 2_b/)
    expect(() => h.baselineConstraintSql("c1")).toThrow(/dropped by 2_b/)
    expect(h.baselineIndexSql("i2")).toContain("CREATE INDEX i2")
  })
})

describe("DO blocks", () => {
  it("reads an explicitly bounded predecessor without claiming a later dynamic patch is parsed", async () => {
    const h = await load({ "1_a": fn("CREATE FUNCTION f1()"), "2_patch": 'DO $$ BEGIN PERFORM f1(); END $$;' })
    expect(() => h.baselineFunctionSql("f1")).toThrow(/DO block/)
    expect(h.baselineFunctionSql("f1", { beforeMigration: "2_patch" })).toContain("CREATE FUNCTION f1()")
    expect(() => h.baselineFunctionSql("f1", { beforeMigration: "missing" })).toThrow(/Unknown migration boundary/)
  })

  it("refuses to guess about an object named inside a DO block, dynamic DDL included", async () => {
    const h = await load({
      "1_a": `ALTER TABLE "T" ADD CONSTRAINT "c1" CHECK (a > 0);\nCREATE TRIGGER "t1" BEFORE INSERT ON "T" FOR EACH ROW EXECUTE FUNCTION f();\n` +
        `CREATE INDEX "i1" ON "T"("a");\n` + fn(`CREATE OR REPLACE FUNCTION f1()`) + `CREATE INDEX other ON "T"("a");\n`,
      "2_b":
        `DO $$ BEGIN\nALTER TABLE "T" DROP CONSTRAINT "c1";\nDROP TRIGGER "t1" ON "T";\n` +
        `EXECUTE 'DROP INDEX "i1"';\nEXCEPTION WHEN undefined_object THEN NULL;\nEND $$;\n` +
        `DO $x$ BEGIN DROP FUNCTION f1(); END $x$ LANGUAGE plpgsql;\n`,
    })
    expect(() => h.baselineConstraintSql("c1")).toThrow(/c1 appears inside a DO block in 2_b/)
    expect(() => h.baselineTriggerSql("t1")).toThrow(/t1 appears inside a DO block in 2_b/)
    expect(() => h.baselineIndexSql("i1")).toThrow(/i1 appears inside a DO block in 2_b/)
    expect(() => h.baselineFunctionSql("f1")).toThrow(/f1 appears inside a DO block in 2_b/)
    expect(h.baselineIndexSql("other")).toContain("CREATE INDEX other")
  })
})

describe("rebuilt constraint action", () => {
  it("ends in one semicolon, without comments, when the ADD is the last action", async () => {
    const h = await load({
      "1_a": `ALTER TABLE "T" ADD CONSTRAINT "c1" CHECK (a > 0);\n`,
      "2_b": `ALTER TABLE "T"\n -- drop first\n DROP CONSTRAINT "c1",\n -- then add\n ADD CONSTRAINT "c1" CHECK (a > 1);\n`,
    })
    expect(h.baselineConstraintSql("c1")).toMatch(/^ALTER TABLE "T"\s+ADD CONSTRAINT "c1" CHECK \(a > 1\);$/)
  })
})

describe("DROP FUNCTION without an argument list, and BEGIN ATOMIC", () => {
  it("counts DROP FUNCTION f1 and DROP FUNCTION IF EXISTS f2 CASCADE as drops", async () => {
    const h = await load({
      "1_a": fn(`CREATE OR REPLACE FUNCTION f1()`) + fn(`CREATE OR REPLACE FUNCTION f2()`),
      "2_b": `DROP FUNCTION f1;\nDROP FUNCTION IF EXISTS public."f2" CASCADE;\n`,
    })
    expect(() => h.baselineFunctionSql("f1")).toThrow(/dropped by 2_b/)
    expect(() => h.baselineFunctionSql("f2")).toThrow(/dropped by 2_b/)
  })

  it("throws on a BEGIN ATOMIC body instead of truncating it", async () => {
    const h = await load({
      "1_a": `CREATE FUNCTION f1() RETURNS int LANGUAGE sql\nBEGIN ATOMIC\n  SELECT 1;\n  SELECT 2;\nEND;\n`,
    })
    expect(() => h.baselineFunctionSql("f1")).toThrow(/f1.*BEGIN ATOMIC/)
  })
})

/**
 * Read hand-written database objects out of the migrations.
 *
 * The 179 inherited migrations were squashed into one baseline (white-label
 * plan, phase 5). Its hand-written section was generated from the catalog of
 * a database built with the old history, so each object appears once, in its
 * final form, as Postgres prints it: functions verbatim from
 * pg_get_functiondef (`$function$` delimiters), and constraints, triggers and
 * indexes as one normalised statement per line. Later migrations that replace
 * or drop one of those objects write it in the same form.
 *
 * The `baseline*Sql` readers return an object's LATEST definition: the one in
 * the newest migration that defines it, or an error if that migration drops it.
 * `readBaselineSql` is the baseline file alone.
 *
 * Static tests read the SQL here. A rule that only holds when it runs belongs
 * in a RUN_*_IT integration test against a migrated database instead.
 */
import fs from "node:fs"
import path from "node:path"

export const BASELINE_MIGRATION_DIR = "20261009000000_baseline"

export const BASELINE_MIGRATION_PATH = path.join(
  __dirname,
  "..",
  "prisma",
  "migrations",
  BASELINE_MIGRATION_DIR,
  "migration.sql",
)

const MIGRATIONS_DIR = path.join(__dirname, "..", "prisma", "migrations")

let cached: string | undefined

export function readBaselineSql(): string {
  cached ??= fs.readFileSync(BASELINE_MIGRATION_PATH, "utf8")
  return cached
}

let migrationsCache: Array<{ dir: string; sql: string }> | undefined

/** Every migration, newest first (Prisma applies them in name order). */
function migrationsNewestFirst(): Array<{ dir: string; sql: string }> {
  migrationsCache ??= fs.readdirSync(MIGRATIONS_DIR)
    .filter((d) => fs.existsSync(path.join(MIGRATIONS_DIR, d, "migration.sql")))
    .sort()
    .reverse()
    .map((dir) => ({ dir, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8") }))
  return migrationsCache
}

/*
 * Statements are matched on the whole file, not line by line, so they may span
 * lines and have any whitespace between words. Keywords are case-insensitive.
 * An object name matches quoted ("x", exact case) or unquoted (x); Postgres
 * folds an unquoted name to lower case, so an unquoted form matches only a
 * name that is already lower case ("Foo" never matches `foo`). A schema
 * qualifier is optional and must be `public`.
 */

/** Case-insensitive pattern for words separated by any whitespace. */
function words(s: string): string {
  return s.split(/\s+/).map(ci).join("\\s+")
}

function ci(s: string): string {
  return [...s].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : escape(c))).join("")
}

/** Pattern for an identifier: quoted exact, or unquoted when `name` is lower case. */
function ident(name: string): string {
  const unquoted = name === name.toLowerCase() ? `|${ci(name)}(?![\\w$])` : ""
  return `(?:"${escape(name)}"${unquoted})`
}

/** Optional `public.` / `"public".` prefix. */
const SCHEMA = `(?:(?:"public"|${ci("public")})\\s*\\.\\s*)?`

/** A statement starting at the beginning of a line (indent allowed). */
function stmt(pattern: string): RegExp {
  return new RegExp(`^[ \\t]*${pattern}`, "gm")
}

function positions(re: RegExp, sql: string): number[] {
  return [...sql.matchAll(re)].map((m) => m.index)
}

/** `sql` from `start` through the first `;` outside a single-quoted literal. */
function statementFrom(sql: string, start: number): string {
  let quoted = false
  for (let i = start; i < sql.length; i++) {
    if (sql[i] === "'") quoted = !quoted
    else if (sql[i] === ";" && !quoted) return sql.slice(start, i + 1)
  }
  throw new Error(`unterminated statement: ${sql.slice(start, start + 80)}`)
}

/**
 * Every definition (one per overload) of public function `name` in the newest
 * migration that defines or drops it, joined.
 */
export function baselineFunctionSql(name: string): string {
  const fn = `${SCHEMA}${ident(name)}\\s*\\(`
  const header = stmt(`${words("CREATE OR REPLACE FUNCTION")}\\s+${fn}`)
  const drop = stmt(`${words("DROP FUNCTION")}\\s+(?:${words("IF EXISTS")}\\s+)?${fn}`)
  const close = /^\$function\$;[ \t]*$/gm
  for (const { dir, sql } of migrationsNewestFirst()) {
    const blocks: string[] = []
    let lastCreate = -1
    let from = 0
    for (const i of positions(header, sql)) {
      if (i < from) continue
      close.lastIndex = i
      const end = close.exec(sql)
      if (!end) throw new Error(`function ${name}: no closing $function$; in ${dir}`)
      from = end.index + end[0].length
      blocks.push(sql.slice(i, from).trimStart())
      lastCreate = i
    }
    const lastDrop = Math.max(-1, ...positions(drop, sql))
    if (lastDrop > lastCreate) throw new Error(`function ${name} is dropped by ${dir}`)
    if (blocks.length > 0) return blocks.join("\n\n")
  }
  throw new Error(`function ${name} is not in any migration`)
}

const IF_EXISTS = `(?:${words("IF EXISTS")}\\s+)?`
const TABLE = `${SCHEMA}(?:"[^"]+"|[a-z_][\\w$]*)`

/** The `ALTER TABLE … ADD CONSTRAINT "name" …;` statement. */
export function baselineConstraintSql(name: string): string {
  const alter = `${words("ALTER TABLE")}\\s+(?:${words("ONLY")}\\s+)?${IF_EXISTS}${TABLE}\\s+`
  return oneStatement(
    stmt(`${alter}${words("ADD CONSTRAINT")}\\s+${ident(name)}\\s`),
    stmt(`${alter}${words("DROP CONSTRAINT")}\\s+${IF_EXISTS}${ident(name)}(?![\\w$"])`),
    `constraint ${name}`,
  )
}

/** The `CREATE [OR REPLACE] [CONSTRAINT] TRIGGER "name" …;` statement. */
export function baselineTriggerSql(name: string): string {
  return oneStatement(
    stmt(`${words("CREATE")}\\s+(?:${words("OR REPLACE")}\\s+)?(?:${words("CONSTRAINT")}\\s+)?${words("TRIGGER")}\\s+${ident(name)}\\s`),
    stmt(`${words("DROP TRIGGER")}\\s+${IF_EXISTS}${ident(name)}\\s`),
    `trigger ${name}`,
  )
}

/** The `CREATE [UNIQUE] INDEX "name" …;` statement. */
export function baselineIndexSql(name: string): string {
  return oneStatement(
    stmt(`${words("CREATE")}\\s+(?:${words("UNIQUE")}\\s+)?${words("INDEX")}\\s+(?:${words("CONCURRENTLY")}\\s+)?(?:${words("IF NOT EXISTS")}\\s+)?${SCHEMA}${ident(name)}\\s`),
    stmt(`${words("DROP INDEX")}\\s+(?:${words("CONCURRENTLY")}\\s+)?${IF_EXISTS}${SCHEMA}${ident(name)}(?![\\w$"])`),
    `index ${name}`,
  )
}

/** The statement in the newest migration that creates or drops the object. */
function oneStatement(create: RegExp, drop: RegExp, what: string): string {
  for (const { dir, sql } of migrationsNewestFirst()) {
    const hits = positions(create, sql)
    const lastDrop = Math.max(-1, ...positions(drop, sql))
    if (hits.length > 1) throw new Error(`${what}: expected 1 statement in ${dir}, found ${hits.length}`)
    if (lastDrop > (hits[0] ?? -1)) throw new Error(`${what} is dropped by ${dir}`)
    if (hits.length === 1) return statementFrom(sql, hits[0]).trimStart()
  }
  throw new Error(`${what}: expected 1 statement in the migrations, found 0`)
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Read hand-written database objects out of the migrations.
 *
 * The 179 inherited migrations were squashed into one baseline (white-label
 * plan, phase 5). Its hand-written section was generated from the catalog of
 * a database built with the old history, so each object appears once, in its
 * final form, as Postgres prints it: functions verbatim from
 * pg_get_functiondef (`$function$` delimiters), and constraints, triggers and
 * indexes as one normalised statement per line. Later migrations may write an
 * object in any valid SQL form: the file is split into top-level statements
 * (comments, strings, quoted identifiers and dollar-quoted bodies skipped), and
 * a CREATE or DROP counts only where it begins such a statement.
 *
 * The `baseline*Sql` readers return an object's LATEST definition: the one in
 * the newest migration that defines it, or an error if that migration drops it.
 * `readBaselineSql` is the baseline file alone.
 *
 * Known limits: an object named inside a DO block, or a function with a BEGIN
 * ATOMIC body, throws (it cannot be read here); a name a DO block builds at run
 * time (format, EXECUTE), and DDL a migration runs through a procedure or
 * function it creates and then calls, are not seen. Not handled: function
 * overloads are not told apart by argument signature, triggers and constraints
 * are looked up by name not table, and RENAME, DISABLE TRIGGER, a DROP TABLE
 * that drops its dependents, and a function created, dropped and created again
 * within one migration (the bodies are joined) are not seen.
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

/** One top-level statement: `text` as written, `code` the same with comments blanked. */
interface Stmt { text: string; code: string; terminated: boolean }

const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/y

/** Index just past the comment, string, quoted identifier or dollar-quoted body starting at `i`; `i` if none. */
function skip(s: string, i: number): number {
  const c = s[i]
  if (c === "-" && s[i + 1] === "-") {
    const nl = s.indexOf("\n", i)
    return nl < 0 ? s.length : nl
  }
  if (c === "/" && s[i + 1] === "*") {
    let depth = 0
    for (let j = i; j < s.length; j++) {
      if (s[j] === "/" && s[j + 1] === "*") { depth++; j++ }
      else if (s[j] === "*" && s[j + 1] === "/" && --depth === 0) return j + 2
    }
    return s.length
  }
  if (c === "'" || c === '"') {
    const backslash = c === "'" && /[eE]/.test(s[i - 1] ?? "") && !/[\w$]/.test(s[i - 2] ?? "")
    for (let j = i + 1; j < s.length; j++) {
      if (backslash && s[j] === "\\") j++
      else if (s[j] === c) {
        if (s[j + 1] !== c) return j + 1
        j++
      }
    }
    throw new Error(`unterminated ${c} at: ${s.slice(i, i + 60)}`)
  }
  if (c === "$" && !/[\w$]/.test(s[i - 1] ?? "")) {
    DOLLAR_TAG.lastIndex = i
    const tag = DOLLAR_TAG.exec(s)?.[0]
    if (tag) {
      const close = s.indexOf(tag, i + tag.length)
      if (close < 0) throw new Error(`unterminated ${tag} at: ${s.slice(i, i + 60)}`)
      return close + tag.length
    }
  }
  return i
}

const isComment = (s: string, i: number) => (s[i] === "-" && s[i + 1] === "-") || (s[i] === "/" && s[i + 1] === "*")

/** `sql` with every comment replaced by spaces (same length, so offsets line up). */
function blankComments(sql: string): string {
  let out = ""
  for (let i = 0; i < sql.length;) {
    const j = skip(sql, i)
    if (j === i) out += sql[i++]
    else {
      out += isComment(sql, i) ? sql.slice(i, j).replace(/[^\n]/g, " ") : sql.slice(i, j)
      i = j
    }
  }
  return out
}

/** Split into top-level statements, each starting at its first token (a trailing one may lack `;`). */
function splitStatements(sql: string): Stmt[] {
  const code = blankComments(sql)
  const out: Stmt[] = []
  let start = -1
  const push = (end: number, terminated: boolean) => {
    if (start >= 0) out.push({ text: sql.slice(start, end), code: code.slice(start, end), terminated })
    start = -1
  }
  for (let i = 0; i < code.length;) {
    if (/\s/.test(code[i])) { i++; continue }
    if (start < 0) start = i
    if (code[i] === ";") { push(++i, true); continue }
    const j = skip(code, i)
    i = j === i ? i + 1 : j
  }
  push(code.length, false)
  return out
}

/** [start, end) of each part of `code` between commas outside parentheses, strings and bodies. */
function splitTopLevel(code: string, from: number): Array<[number, number]> {
  const parts: Array<[number, number]> = []
  let depth = 0
  let start = from
  for (let i = from; i < code.length;) {
    const j = skip(code, i)
    if (j !== i) { i = j; continue }
    if (code[i] === "(") depth++
    else if (code[i] === ")") depth--
    else if (code[i] === "," && depth === 0) { parts.push([start, i]); start = i + 1 }
    i++
  }
  parts.push([start, code.length])
  return parts
}

let migrationsCache: Array<{ dir: string; stmts: Stmt[] }> | undefined

/** Every migration, newest first (Prisma applies them in name order). */
function migrationsNewestFirst(): Array<{ dir: string; stmts: Stmt[] }> {
  migrationsCache ??= fs.readdirSync(MIGRATIONS_DIR)
    .filter((d) => fs.existsSync(path.join(MIGRATIONS_DIR, d, "migration.sql")))
    .sort()
    .reverse()
    .map((dir) => ({ dir, stmts: splitStatements(fs.readFileSync(path.join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8")) }))
  return migrationsCache
}

/*
 * Keywords are case-insensitive and separated by any whitespace. An object name
 * matches quoted ("x", exact case) or unquoted (x); Postgres folds an unquoted
 * name to lower case, so an unquoted form matches only a name that is already
 * lower case ("Foo" never matches `foo`). A schema qualifier is optional and
 * must be `public`.
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
const IF_EXISTS = `(?:${words("IF EXISTS")}\\s+)?`
const TABLE = `${SCHEMA}(?:"[^"]+"|[A-Za-z_][\\w$]*)`

/** What one statement does to the object: it is created (with this text) or dropped. */
type Event = { text: string } | "drop"

/** Reads the events one statement has for the object, in order. */
type Reader = (s: Stmt) => Event[]

function whole(s: Stmt): string {
  if (!s.terminated) throw new Error(`unterminated statement: ${s.text.slice(0, 80)}`)
  return s.text
}

/** A statement beginning with `head`: a create event with its text, or a drop. */
function simple(create: string, drop: string): Reader {
  const c = new RegExp(`^${create}`)
  const d = new RegExp(`^${drop}`)
  return (s) => (c.test(s.code) ? [{ text: whole(s) }] : d.test(s.code) ? ["drop"] : [])
}

/** `DROP <head> a, b, c`: dropped when any listed item matches `item`. */
function dropList(head: string, item: string): Reader {
  const h = new RegExp(`^${head}`)
  const it = new RegExp(`^\\s*${item}`)
  return (s) => {
    const m = h.exec(s.code)
    return m && splitTopLevel(s.code, m[0].length).some(([a, b]) => it.test(s.code.slice(a, b))) ? ["drop"] : []
  }
}

/**
 * Walk the newest-first migrations for the first one with an event for the
 * object; its last event decides (drop, or the creates).
 */
function latest(name: string, read: Reader[], what: string, many = false): string[] {
  const mention = new RegExp(`(?<![\\w$])${ident(name)}`)
  for (const { dir, stmts } of migrationsNewestFirst()) {
    // DDL inside a DO body (or EXECUTE'd from one) is not parsed: refuse rather than guess
    if (stmts.some((s) => /^DO(?![\w$])/i.test(s.code) && mention.test(s.code))) {
      throw new Error(`${name} appears inside a DO block in ${dir}; the helper cannot read it - assert on that migration directly`)
    }
    const events = stmts.flatMap((s) => read.flatMap((r) => r(s)))
    const creates = events.filter((e): e is { text: string } => e !== "drop").map((e) => e.text)
    if (creates.length === 0 && events.length === 0) continue
    if (!many && creates.length > 1) {
      throw new Error(`${what}: expected 1 statement in ${dir}, found ${creates.length}`)
    }
    if (events[events.length - 1] === "drop") throw new Error(`${what} is dropped by ${dir}`)
    return creates
  }
  throw new Error(many ? `${what} is not in any migration` : `${what}: expected 1 statement in the migrations, found 0`)
}

/**
 * Every definition (one per overload) of public function `name` in the newest
 * migration that defines or drops it, joined.
 */
export function baselineFunctionSql(name: string): string {
  const fn = `${SCHEMA}${ident(name)}\\s*\\(`
  const create = simple(`${words("CREATE")}\\s+(?:${words("OR REPLACE")}\\s+)?${words("FUNCTION")}\\s+${fn}`, "(?!)")
  return latest(name, [
    (s) => {
      const events = create(s)
      // a SQL-standard body holds `;`, so the split cut it short
      if (events.length && /\bBEGIN\s+ATOMIC\b/i.test(s.code)) throw new Error(`function ${name} has a BEGIN ATOMIC body; the helper cannot read it`)
      return events
    },
    dropList(`${words("DROP FUNCTION")}\\s+${IF_EXISTS}`, `${SCHEMA}${ident(name)}(?![\\w$"])`),
  ], `function ${name}`, true).join("\n\n")
}

/** The `ALTER TABLE … ADD CONSTRAINT "name" …;` statement. */
export function baselineConstraintSql(name: string): string {
  const alter = new RegExp(`^${words("ALTER TABLE")}\\s+${IF_EXISTS}(?:${words("ONLY")}\\s+)?${TABLE}\\s+`)
  const add = new RegExp(`^${words("ADD CONSTRAINT")}\\s+${ident(name)}\\s`)
  const drop = new RegExp(`^${words("DROP CONSTRAINT")}\\s+${IF_EXISTS}${ident(name)}(?![\\w$"])`)
  const read: Reader = (s) => {
    const m = alter.exec(s.code)
    if (!m) return []
    const actions = splitTopLevel(s.code, m[0].length)
    return actions.flatMap(([a, b]): Event[] => {
      const action = s.code.slice(a, b).trimStart()
      if (drop.test(action)) return ["drop"]
      if (!add.test(action)) return []
      // a lone action keeps the whole statement; one of several is rebuilt on its own
      return [{ text: actions.length === 1 ? whole(s) : `${s.code.slice(0, m[0].length)}${s.code.slice(a, b).trim().replace(/;$/, "")};` }]
    })
  }
  return latest(name, [read], `constraint ${name}`)[0]
}

/** The `CREATE [OR REPLACE] [CONSTRAINT] TRIGGER "name" …;` statement. */
export function baselineTriggerSql(name: string): string {
  return latest(name, [simple(
    `${words("CREATE")}\\s+(?:${words("OR REPLACE")}\\s+)?(?:${words("CONSTRAINT")}\\s+)?${words("TRIGGER")}\\s+${ident(name)}\\s`,
    `${words("DROP TRIGGER")}\\s+${IF_EXISTS}${ident(name)}\\s`,
  )], `trigger ${name}`)[0]
}

/** The `CREATE [UNIQUE] INDEX "name" …;` statement. */
export function baselineIndexSql(name: string): string {
  return latest(name, [
    simple(
      `${words("CREATE")}\\s+(?:${words("UNIQUE")}\\s+)?${words("INDEX")}\\s+(?:${words("CONCURRENTLY")}\\s+)?(?:${words("IF NOT EXISTS")}\\s+)?${SCHEMA}${ident(name)}\\s`,
      "(?!)",
    ),
    dropList(`${words("DROP INDEX")}\\s+(?:${words("CONCURRENTLY")}\\s+)?${IF_EXISTS}`, `${SCHEMA}${ident(name)}(?![\\w$"])`),
  ], `index ${name}`)[0]
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

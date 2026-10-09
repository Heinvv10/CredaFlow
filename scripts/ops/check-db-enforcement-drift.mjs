#!/usr/bin/env node
/**
 * Does the LIVE database still enforce what the migrations declare?
 *
 * Triggers dropped by hand to clear an outage and never restored are invisible
 * to every other check: not a test, not a deploy, not a walkthrough — and a
 * staging database missing the same objects makes every green run green
 * against a weakened database.
 *
 * A mocked Prisma cannot execute a trigger, and a UI walkthrough cannot see one
 * that is absent. The only thing that can catch this is asking the server.
 *
 *   node scripts/ops/check-db-enforcement-drift.mjs --psql '<command>'
 *   node scripts/ops/check-db-enforcement-drift.mjs --psql '...' --json
 *
 * Exit 0 = live enforcement matches the migrations. Exit 1 = drift, named.
 *
 * CONSIDERED AND DECLINED, so the next reader does not re-derive them:
 *
 *   Keying CHECK constraints by relation, as triggers are. Implemented, then
 *   REVERTED: it lost 4 tracked constraints (24 -> 20 expected) to fix a
 *   hypothetical -- prod has ZERO duplicate CHECK names across relations.
 *   Trading real coverage for a theoretical false green is the wrong trade.
 *
 *   Verifying each trigger's function still exists. Structurally near
 *   impossible in Postgres: dropping a function a trigger depends on requires
 *   CASCADE, which drops the trigger with it. Measured 0 orphans on prod.
 *
 * Both were raised by blind review and both are defensible; they are declined
 * on evidence, not overlooked.
 *
 * FUNCTION EXISTING IS NOT FUNCTION CORRECT
 *
 * The trigger-existence check above has a gap the credit-life outage of
 * 2026-08-02 fell straight through: CREATE OR REPLACE FUNCTION changes a
 * function's BODY without touching the TRIGGER object at all, so a trigger
 * this gate reports as present can still be silently running the wrong
 * logic. guardLoanApplicationCreditLifeOffer() regressed to an earlier
 * body -- dropping the "no offer was disclosed" bypass
 * branch -- while its trigger stayed exactly where migrations expected it,
 * so this gate would have read green through the entire ~30-hour outage.
 * FUNCTION_BODY_MARKERS below closes that one gap surgically (substring
 * presence in pg_get_functiondef, not a full diff) rather than generalizing
 * to every function in the schema.
 *
 * WHY THIS REPLAYS RATHER THAN DIFFS
 *
 * A naive "every CREATE TRIGGER in migrations/ vs pg_trigger" is wrong twice
 * over. Migrations legitimately DROP triggers, so a diff reports correctly
 * removed ones as missing. And the repo's own idempotency idiom is
 * `DROP TRIGGER IF EXISTS x; CREATE TRIGGER x ...` inside ONE file — a diff
 * that treats drops as authoritative would report a trigger as intentionally
 * gone when the very next line recreates it. Only replaying every statement in
 * order gives the true expected set. I nearly shipped the naive version.
 */
import fs from "node:fs"
import path from "node:path"
import { execSync } from "node:child_process"

const argv = process.argv.slice(2)
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const PSQL = arg("--psql") ?? process.env.DRIFT_PSQL
const AS_JSON = argv.includes("--json")
const MIGRATIONS = arg("--migrations") ?? "prisma/migrations"

if (!PSQL) {
  console.error("usage: check-db-enforcement-drift.mjs --psql '<command reading SQL on stdin>'")
  process.exit(2)
}

/** Replay every migration in order; CREATE adds, DROP removes. */
function expectedFromMigrations(dir) {
  const triggers = new Set()
  const checks = new Set()
  const dirs = fs.readdirSync(dir).filter((d) => /^\d/.test(d)).sort()
  for (const d of dirs) {
    const file = path.join(dir, d, "migration.sql")
    if (!fs.existsSync(file)) continue
    const sql = fs.readFileSync(file, "utf8")
    // Names this file recreates through DYNAMIC SQL -- an EXECUTE whose
    // statement is assembled by string concatenation, which no statement-level
    // regex can see. A migration that dropped
    // LoanApplication_approved_status_requires_pasq normally and rebuilt it
    // that way made the naive parser delete it from the expected set, and the
    // gate went blind to a live compliance CHECK.
    //
    // Matched PRECISELY: the name must appear in an ADD CONSTRAINT that is
    // followed by CHECK, allowing the quoting and || concatenation between. An
    // earlier attempt used a loose `_guard|_requires` heuristic and swept 18
    // TRIGGER and FUNCTION names into the constraint set -- 18 false positives,
    // which is worse than the blindness it fixed, because a gate that cries
    // wolf teaches people to ignore it.
    const dynamic = new Set(
      [...sql.matchAll(
        /ADD\s+CONSTRAINT\s+[^;]{0,40}?"([A-Za-z0-9_]+)"[^;]{0,120}?CHECK/gi,
      )].map((m) => m[1]),
    )
    // Statement order matters: DROP-then-CREATE in one file must end as CREATE.
    const stmts = sql.split(";")
    for (const stmt of stmts) {
      let m = stmt.match(
        /DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?\s+ON\s+(?:"?[A-Za-z0-9_]+"?\.)?"?([A-Za-z0-9_]+)"?/i,
      )
      if (m) { triggers.delete(`${m[2]}.${m[1]}`); continue }
      m = stmt.match(
        /CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+"?([A-Za-z0-9_]+)"?[\s\S]*?\sON\s+(?:"?[A-Za-z0-9_]+"?\.)?"?([A-Za-z0-9_]+)"?/i,
      )
      // Keyed relation.name, because these names are NOT globally unique: a
      // same-named trigger on another table would otherwise satisfy the
      // expectation and produce a false green.
      if (m) { triggers.add(`${m[2]}.${m[1]}`); continue }
      m = stmt.match(/DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/i)
      // Do NOT forget a constraint this same file rebuilds dynamically.
      if (m) { if (!dynamic.has(m[1])) checks.delete(m[1]); continue }
      m = stmt.match(/ADD\s+CONSTRAINT\s+"?([A-Za-z0-9_]+)"?\s+CHECK/i)
      if (m) { checks.add(m[1]); continue }
    }
    for (const name of dynamic) {
      checks.add(name)
    }
  }
  return { triggers, checks }
}

function query(sql) {
  return execSync(PSQL, { input: sql, encoding: "utf8", timeout: 60_000 })
    .split("\n").map((l) => l.trim()).filter(Boolean)
}

// Unlike query(), does not split/trim/filter by line: pg_get_functiondef()
// returns ONE value whose CONTENTS are multi-line PL/pgSQL source, not one
// row per line. Reusing query()'s line-oriented splitting would silently
// strip whitespace and drop blank lines out of the reconstructed body --
// harmless for a single-token marker today, but corrupts anything
// whitespace- or line-adjacency-sensitive later.
function queryRaw(sql) {
  return execSync(PSQL, { input: sql, encoding: "utf8", timeout: 60_000 })
}

// Functions that have regressed silently before: required substring(s) that
// must appear in the LIVE pg_get_functiondef() output. A function missing
// from this map is simply not checked, same as before this addition existed
// -- this is a targeted list of known-fragile functions, not a schema-wide
// body diff.
const FUNCTION_BODY_MARKERS = {
  guardLoanApplicationCreditLifeOffer: ["credit-life-no-offer-v1"],
  // Found 2026-08-04: staging alone was silently running the body from
  // before the PASQ-at-signing-ceremony change, which unconditionally
  // requires a PASQ document at approval. No migration in the repo produces
  // that body -- prod had the correct one the whole time -- so this was
  // undocumented drift, not a captured incident like the credit-life one.
  // `ceremony_open` only exists in the post-ceremony-refactor version.
  guardLoanApplicationPasqApproval: ["ceremony_open"],
  // Both agreement guards key on the BINDING column. Gutting either body to a
  // bare `RETURN NEW` — the credit-life failure shape, where the trigger object
  // survives and the enforcement does not — removes these strings, so the
  // marker catches it. The trigger-existence check above cannot.
  guardBoundAgreementDocument: ["agreementDocumentId"],
  guardBoundExecutedAgreement: ["agreementExecutedDocumentId"],
}

function checkFunctionBodies() {
  const missing = []
  for (const [fn, markers] of Object.entries(FUNCTION_BODY_MARKERS)) {
    // to_regprocedure() returns NULL for an unknown function; the `::regprocedure`
    // cast instead THROWS "function ... does not exist", which under a
    // -v ON_ERROR_STOP=1 psql invocation makes execSync throw and crashes this
    // whole script uninformatively -- discarding the trigger/check results
    // already computed above it. NULL-check explicitly instead.
    const existsRow = query(
      `SELECT to_regprocedure('"${fn}"()') IS NOT NULL;`,
    )
    if (!existsRow.some((l) => l === "t")) {
      missing.push(`${fn}: function does not exist`)
      continue
    }
    const body = queryRaw(
      `SELECT pg_get_functiondef('"${fn}"()'::regprocedure);`,
    )
    for (const marker of markers) {
      if (!body.includes(marker)) missing.push(`${fn}: missing "${marker}"`)
    }
  }
  return missing
}

const expected = expectedFromMigrations(MIGRATIONS)

// Ask the SERVER. Its answer is the only authority on what is enforced.
// tgenabled 'D' means the trigger EXISTS and does not run. Counting it as
// live would report enforcement that cannot fire -- the exact false green this
// gate exists to prevent. Relation is carried too because these names are not
// globally unique, so a same-named trigger on another table must not satisfy
// the expectation.
const liveTriggerRows = query(
  `SELECT c.relname || '.' || t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND t.tgenabled IN ('O', 'A');`,
)
// 'D' is disabled and 'R' is replica-only -- a replica trigger never fires on
// an origin server, so counting it as enforcement is the same false green as
// counting a disabled one. Only 'O' (origin) and 'A' (always) enforce.
const liveTriggers = new Set(liveTriggerRows)
const liveChecks = new Set(query(
  `SELECT conname FROM pg_constraint WHERE contype = 'c';`,
))

const missingTriggers = [...expected.triggers].filter((t) => !liveTriggers.has(t)).sort()
const missingChecks = [...expected.checks].filter((c) => !liveChecks.has(c)).sort()
const wrongFunctionBodies = checkFunctionBodies()
// Extra objects are NOT drift: Prisma and Postgres create their own, and a
// hotfix applied ahead of its migration is a separate (documented) situation.
// Reporting them would train people to ignore this gate.
const report = {
  expectedTriggers: expected.triggers.size,
  liveTriggers: liveTriggers.size,
  missingTriggers,
  expectedChecks: expected.checks.size,
  liveChecks: liveChecks.size,
  missingChecks,
  wrongFunctionBodies,
  ok: missingTriggers.length === 0 && missingChecks.length === 0 && wrongFunctionBodies.length === 0,
}

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2))
} else if (report.ok) {
  console.log(
    `DB enforcement OK — ${expected.triggers.size} triggers and ${expected.checks.size} CHECK ` +
    `constraints declared by migrations are all live, and ${Object.keys(FUNCTION_BODY_MARKERS).length} ` +
    `watched function bodies carry their required markers.`,
  )
} else {
  console.error("DB ENFORCEMENT DRIFT — the live database does not enforce what the migrations declare.\n")
  if (missingTriggers.length) {
    console.error(`  MISSING TRIGGERS (${missingTriggers.length}):`)
    for (const t of missingTriggers) console.error(`    ${t}`)
  }
  if (missingChecks.length) {
    console.error(`\n  MISSING CHECK CONSTRAINTS (${missingChecks.length}):`)
    for (const c of missingChecks) console.error(`    ${c}`)
  }
  if (wrongFunctionBodies.length) {
    console.error(`\n  WRONG FUNCTION BODIES (${wrongFunctionBodies.length}):`)
    for (const f of wrongFunctionBodies) console.error(`    ${f}`)
  }
  console.error(
    "\n  A missing trigger is enforcement the CODE ASSUMES EXISTS. Mocked tests cannot\n" +
    "  see it and a UI walkthrough cannot either. Restoring one is not routine:\n" +
    "  enforcement takes effect immediately and can reject writes the running code\n" +
    "  still makes. Screen the gap before applying anything.",
  )
}
process.exit(report.ok ? 0 : 1)

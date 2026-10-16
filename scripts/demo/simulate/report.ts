/**
 * The bake's verification report, from the read-only connection: what the
 * book looks like, whether every storyline reached its target, the ledger
 * invariant, and the date check. Printed to stdout; returns false when any
 * check fails.
 *
 *   npx tsx scripts/demo/simulate/report.ts      (also runs at the end of simulate.ts)
 */
import { breadthReport } from "../breadth/report"
import { getPersona } from "../personas"
import { checkDates, describeViolations } from "../sim/check-dates"
import { closeReadDb, readDb } from "../sim/readonly-db"
import { buildPlans, type Window } from "./plan"
import { loadState, type SimState } from "./state"

type Row = Record<string, string | number | bigint | null>

const out = (line = ""): void => {
  process.stdout.write(`${line}\n`)
}

async function table(title: string, sql: string): Promise<Row[]> {
  const rows = await readDb().$queryRawUnsafe<Row[]>(sql)
  out(`\n## ${title}`)
  for (const r of rows) out(`  ${Object.values(r).map((v) => String(v)).join(" | ")}`)
  return rows
}

/** What each storyline must look like on the end date. */
function expectation(storyline: string): (loan: Row | undefined, app: Row | undefined) => string | null {
  const loanIs = (statuses: string[], extra?: (l: Row) => string | null) => (l: Row | undefined) =>
    !l ? "no loan" : !statuses.includes(String(l.status)) ? `loan ${l.status}` : extra ? extra(l) : null
  const dpd = (lo: number, hi: number) => (l: Row) =>
    Number(l.dpd) >= lo && Number(l.dpd) <= hi ? null : `DPD ${l.dpd} not in [${lo}, ${hi}]`
  const appIs = (status: string) => (_l: Row | undefined, a: Row | undefined) =>
    a?.status === status ? null : `application ${a?.status ?? "missing"}`
  switch (storyline) {
    case "settled": case "live-returning-client": return loanIs(["COMPLETED"])
    case "active": return loanIs(["ACTIVE"], dpd(0, 5))
    case "arrears-30": return loanIs(["ACTIVE"], dpd(25, 35))
    case "arrears-60": return loanIs(["ACTIVE", "DEFAULTED"], dpd(55, 65))
    case "arrears-90": return loanIs(["DEFAULTED"], dpd(85, 95))
    case "s129": return loanIs(["DEFAULTED"], (l) => ["SECTION_129_SENT", "ATTORNEY_REFERRED"].includes(String(l.stage)) ? null : `stage ${l.stage}`)
    case "payment-plan": return loanIs(["ACTIVE", "DEFAULTED"], (l) => l.stage === "PAYMENT_ARRANGEMENT" ? null : `stage ${l.stage}`)
    case "written-off": return loanIs(["WRITTEN_OFF"])
    case "declined": return appIs("DECLINED")
    case "withdrawn": return appIs("CANCELLED")
    case "origination-draft": return appIs("DRAFT")
    case "origination-submitted": return appIs("SUBMITTED")
    case "origination-under-review": return appIs("UNDER_REVIEW")
    case "origination-approved": case "origination-signed": return appIs("APPROVED")
    default: return () => `no expectation for ${storyline}`
  }
}

/**
 * What a prospect reads off the dashboard and the applications board (Fair
 * Score audit): PAR30 by balance at most 15%, defaults and write-offs a small
 * minority, no open application older than 30 days, and the presenter's two
 * new-client personas not yet in the book.
 */
async function bookHealth(window: Window): Promise<boolean> {
  const [b] = await readDb().$queryRawUnsafe<Row[]>(`
    SELECT
      coalesce(sum("outstandingPrincipal") FILTER (WHERE "daysInArrears" > 30), 0)::float
        / nullif(sum("outstandingPrincipal"), 0)::float AS par30,
      (SELECT count(*) FROM "Loan" WHERE status IN ('DEFAULTED','PENDING_WRITE_OFF','WRITTEN_OFF'))::float
        / nullif((SELECT count(*) FROM "Loan"), 0)::float AS bad_share,
      (SELECT coalesce(max(DATE '${window.until}' - "createdAt"::date), 0) FROM "LoanApplication"
        WHERE status IN ('DRAFT','SUBMITTED','UNDER_REVIEW','APPROVED')) AS oldest_open_days
    FROM "Loan" WHERE status IN ('ACTIVE','DEFAULTED','PENDING_WRITE_OFF')`)
  const unused = ["live-clean-approve", "live-affordability-decline"].map((id) => getPersona(id).idNumber)
  const [used] = await readDb().$queryRawUnsafe<Row[]>(
    `SELECT count(*) AS n FROM "Client" WHERE "idNumber" IN (${unused.map((id) => `'${id}'`).join(", ")})`)
  const checks: Array<[string, boolean, string]> = [
    ["PAR30 by balance <= 15%", Number(b.par30 ?? 0) <= 0.15, `${(Number(b.par30 ?? 0) * 100).toFixed(1)}%`],
    ["defaulted + written off <= 20% of loans", Number(b.bad_share ?? 0) <= 0.2, `${(Number(b.bad_share ?? 0) * 100).toFixed(1)}%`],
    ["oldest open application <= 30 days", Number(b.oldest_open_days) <= 30, `${Number(b.oldest_open_days)} days`],
    ["Lerato and Mxolisi not yet clients (kit personas unused)", Number(used.n) === 0, `${Number(used.n)} found`],
  ]
  out("\n## Book health")
  for (const [name, pass, value] of checks) out(`  ${pass ? "ok  " : "MISS"} ${name}: ${value}`)
  return checks.every(([, pass]) => pass)
}

export async function report(state: SimState, window: Window): Promise<boolean> {
  let ok = true
  out(`# Demo bake report — ${window.start} … ${window.until}`)
  await table("Loans by status", `SELECT status, count(*) FROM "Loan" GROUP BY 1 ORDER BY 1`)
  await table("Open loans (ACTIVE/DEFAULTED/PENDING_WRITE_OFF) by DPD bucket", `
    SELECT CASE WHEN "daysInArrears" = 0 THEN '0 current' WHEN "daysInArrears" <= 30 THEN '1-30'
      WHEN "daysInArrears" <= 60 THEN '31-60' WHEN "daysInArrears" <= 90 THEN '61-90' ELSE '91+' END AS bucket, count(*)
    FROM "Loan" WHERE status IN ('ACTIVE','DEFAULTED','PENDING_WRITE_OFF') GROUP BY 1 ORDER BY 1`)
  await table("Applications by status", `SELECT status, count(*) FROM "LoanApplication" GROUP BY 1 ORDER BY 1`)
  await table("Payments by method / allocation / reversed", `
    SELECT "paymentMethod", "allocationStatus", reversed, count(*), sum(amount)/100.0 AS rands FROM "Payment" GROUP BY 1,2,3 ORDER BY 1,2,3`)
  await table("Section 129 notices by lifecycle", `
    SELECT data->>'lifecycle' AS lifecycle, status, count(*) FROM "ComplianceRecord" WHERE type = 'SECTION_129_NOTICE' GROUP BY 1,2`)
  await table("Payment arrangements", `SELECT a.status, l.reference, a."agreedAmount"/100.0 AS agreed, a."startDate"::date::text AS start_day, a."endDate"::date::text AS end_day FROM "PaymentArrangement" a JOIN "Loan" l ON l.id = a."loanId"`)
  await table("Payment plans", `SELECT l.reference, p.installments, p."installmentAmt"/100.0 AS amt, p.active FROM "PaymentPlan" p JOIN "Loan" l ON l.id = p."loanId"`)
  await table("Attorney referrals", `SELECT l.reference, r."firmName", r."matterNumber" FROM "AttorneyReferral" r JOIN "Loan" l ON l.id = r."loanId"`)
  await table("Write-offs", `SELECT reference, "writeOffAt"::date::text AS written_off, "writeOffRequestedById" <> "writeOffApprovedById" AS dual_control FROM "Loan" WHERE status = 'WRITTEN_OFF'`)
  await table("Collections stages (open loans)", `SELECT "collectionsStage", count(*) FROM "Loan" WHERE status IN ('ACTIVE','DEFAULTED') GROUP BY 1 ORDER BY 1`)
  await table("Email delivered to the sink, by category", `SELECT category, status, count(*) FROM "EmailLog" GROUP BY 1,2 ORDER BY 1,2`)

  out("\n## Storylines (persona → target → actual)")
  const loans = await readDb().$queryRawUnsafe<Row[]>(`
    SELECT c.email, l.status, l."daysInArrears" AS dpd, l."collectionsStage" AS stage, l.reference
    FROM "Loan" l JOIN "Client" c ON c.id = l."clientId"`)
  const apps = await readDb().$queryRawUnsafe<Row[]>(`
    SELECT c.email, a.status, a.reference FROM "LoanApplication" a JOIN "Client" c ON c.id = a."clientId" ORDER BY a."createdAt" DESC`)
  for (const plan of buildPlans(window)) {
    const p = getPersona(plan.persona.id)
    const loan = loans.find((l) => l.email === p.email)
    const app = apps.find((a) => a.email === p.email)
    const failed = state.failedPersonas.includes(p.id)
    const miss = failed ? "storyline failed (see failures)" : expectation(p.storyline)(loan, app)
    if (miss) ok = false
    out(`  ${miss ? "MISS" : "ok  "} ${p.id} ${p.storyline}: loan ${loan?.reference ?? "-"} ${loan?.status ?? ""} dpd=${loan?.dpd ?? "-"} stage=${loan?.stage ?? "-"}; app ${app?.status ?? "-"}${miss ? ` ← ${miss}` : ""}`)
  }

  const returning = getPersona("live-returning-client")
  const rc = await readDb().$queryRawUnsafe<Row[]>(`
    SELECT (SELECT count(*) FROM "Loan" l JOIN "Client" c ON c.id = l."clientId" WHERE c.email = '${returning.email}' AND l.status = 'COMPLETED') AS settled,
           (SELECT count(*) FROM "Loan" l JOIN "Client" c ON c.id = l."clientId" WHERE c.email = '${returning.email}') AS loans,
           (SELECT count(*) FROM "LoanApplication" a JOIN "Client" c ON c.id = a."clientId" WHERE c.email = '${returning.email}'
              AND a.status IN ('DRAFT','SUBMITTED','UNDER_REVIEW','APPROVED')) AS open_apps`)
  const rcOk = Number(rc[0].settled) === 1 && Number(rc[0].loans) === 1 && Number(rc[0].open_apps) === 0
  if (!rcOk) ok = false
  out(`\n## Returning client: ${rcOk ? "ok" : "MISS"} — ${JSON.stringify(rc[0], (_k, v: unknown) => (typeof v === "bigint" ? Number(v) : v))}`)

  if (!(await bookHealth(window))) ok = false
  if (!(await breadthReport())) ok = false

  out("\n## Ledger invariant: SELECT assert_payment_allocation_reconciles()")
  try {
    await readDb().$queryRawUnsafe(`SELECT assert_payment_allocation_reconciles()::text`)
    out("  holds (no exception)")
  } catch (err) {
    ok = false
    out(`  VIOLATED: ${err instanceof Error ? err.message : String(err)}`)
  }

  const violations = await checkDates(new Date(`${window.start}T00:00:00+02:00`), new Date(`${window.until}T23:59:59+02:00`))
  out(`\n## check-dates: ${violations.length === 0 ? "passed" : `FAILED\n${describeViolations(violations)}`}`)
  if (violations.length > 0) ok = false

  out(`\n## Failures (non-2xx or refused actions): ${state.failures.length}`)
  for (const f of state.failures) out(`  ${f.day} ${f.eventId}: ${f.error.slice(0, 400)}`)
  out(`## Cron failures: ${state.cronFailures.length}`)
  for (const f of state.cronFailures) out(`  ${f.day} ${f.name} ${f.status}: ${f.body.slice(0, 300)}`)
  if (state.failures.length > 0 || state.cronFailures.length > 0) ok = false
  return ok
}

if (require.main === module) {
  const state = loadState()
  if (!state) throw new Error("no saved simulator state; run simulate.ts first")
  import("./window")
    .then(({ simWindow }) => report(state, simWindow(state.start, state.until)))
    .then((passed) => { process.exitCode = passed ? 0 : 1 })
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
      process.exitCode = 1
    })
    .finally(() => closeReadDb())
}

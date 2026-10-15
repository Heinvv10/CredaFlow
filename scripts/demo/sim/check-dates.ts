/**
 * Post-run date check: scans every timestamp/date column of every table and
 * fails if a value lies outside [simStart − 31 days, simEnd + 1 day]. A value
 * outside means something was stamped by a clock other than the sim's (the
 * real clock leaking past libfaketime) — the bake would then show "today" in
 * the middle of April's history.
 *
 * Run during the bake too, with simEnd = the sim's current time: while the
 * simulated date is months behind the real one, a leaked real timestamp is
 * far in the future and caught at once (at the end of a bake that ends today
 * it would be indistinguishable from a legitimate one).
 *
 * Excluded, because they are business dates rather than event stamps and may
 * lawfully lie outside the window (each with its reason):
 *   - _prisma_migrations: `prisma migrate deploy` runs on the host, real clock;
 *   - SaProclaimedPublicHoliday: reference calendar rows a migration inserts;
 *   - BUSINESS_DATE_COLUMNS below.
 *
 *   npx tsx scripts/demo/sim/check-dates.ts --start 2026-04-01 --end 2026-10-10
 */
import { log } from "./env"
import { closeReadDb, readDb } from "./readonly-db"

const DAY_MS = 86_400_000

const EXCLUDED_TABLES = new Set(["_prisma_migrations", "SaProclaimedPublicHoliday"])

/**
 * Columns holding past or future business dates, not event stamps: a bare
 * column name applies to every table, "Table.column" to that table only.
 */
const BUSINESS_DATE_COLUMNS: Readonly<Record<string, string>> = {
  "StatementAnalysis.periodStart": "the statement coverage period may predate the simulation window",
  "StatementAnalysis.periodEnd": "the statement coverage period may predate the simulation window",
  "BankStatementImport.periodStart": "the imported statement period may predate the simulation window",
  "BankStatementImport.periodEnd": "the imported statement period may predate the simulation window",
  "ReferenceRate.effectiveDate": "a reference rate history predates the simulated book",
  "ContractRate.effectiveDate": "a contract rate is the date its pricing terms take effect",
  "VatRate.effectiveDate": "the national VAT rate history predates the simulated book",
  "PaymentArrangement.startDate": "an arrangement's first agreed payment, often next month",
  "PaymentPlan.startDate": "a payment plan's first instalment, often next month",
  dateOfBirth: "a person's birth date",
  employmentStartDate: "when the client started their job",
  maturityDate: "a loan's contractual end, months ahead",
  dueDate: "instalment due dates run to the end of the term",
  nextPaymentDate: "the next instalment date",
  endDate: "an arrangement's last agreed payment",
  expires: "session expiry, 30 days ahead",
  expiresAt: "token/link/quote expiry, ahead by design",
  resetTokenExp: "password-reset expiry",
  dispatchLeaseExpiresAt: "a dispatch lease's expiry",
  nextRetryAt: "a scheduled retry",
  licenceExpiry: "a licence's expiry date",
  waitingPeriodEnds: "an insurance waiting period's end",
  effectiveTo: "a rate table's validity end",
  renewalDate: "an insurance policy's renewal date",
  ncrRegistrationDate: "the lender's NCR registration date",
  fscaAuthorisationDate: "the lender's FSCA authorisation date",
  faisRepresentativeFrom: "a FAIS representative's appointment date",
  reExamPassDate: "a FAIS regulatory exam pass date",
  "MaintenanceFund.leaseEndDate": "an asset-finance lease's contractual end, years ahead",
  "LeaseTerminationQuote.terminationDate": "the termination date a settlement quote proposes, ahead by design",
  cpdPeriodEnd: "a CPD cycle end",
  bureauReportingStartDate: "the lender's bureau reporting start",
}

export function isBusinessDateColumn(table: string, column: string): boolean {
  return column in BUSINESS_DATE_COLUMNS || `${table}.${column}` in BUSINESS_DATE_COLUMNS
}

export interface DateViolation {
  table: string
  column: string
  outside: number
  min: string | null
  max: string | null
}

interface ColumnRow {
  table_name: string
  column_name: string
}

const sqlTs = (d: Date): string => d.toISOString().replace("T", " ").replace("Z", "")

export async function checkDates(simStart: Date, simEnd: Date): Promise<DateViolation[]> {
  const lo = new Date(simStart.getTime() - 31 * DAY_MS)
  const hi = new Date(simEnd.getTime() + DAY_MS)
  const columns = await readDb().$queryRawUnsafe<ColumnRow[]>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND data_type IN ('timestamp without time zone', 'timestamp with time zone', 'date')
     ORDER BY table_name, column_name`,
  )
  const byTable = new Map<string, string[]>()
  for (const c of columns) {
    if (EXCLUDED_TABLES.has(c.table_name) || isBusinessDateColumn(c.table_name, c.column_name)) continue
    byTable.set(c.table_name, [...(byTable.get(c.table_name) ?? []), c.column_name])
  }

  const violations: DateViolation[] = []
  for (const [table, cols] of byTable) {
    const selects = cols.map((c, i) =>
      `count(*) FILTER (WHERE "${c}" < '${sqlTs(lo)}' OR "${c}" > '${sqlTs(hi)}') AS o${i}, ` +
      `min("${c}") FILTER (WHERE "${c}" < '${sqlTs(lo)}' OR "${c}" > '${sqlTs(hi)}')::text AS mn${i}, ` +
      `max("${c}") FILTER (WHERE "${c}" < '${sqlTs(lo)}' OR "${c}" > '${sqlTs(hi)}')::text AS mx${i}`)
    const [row] = await readDb().$queryRawUnsafe<Array<Record<string, bigint | string | null>>>(
      `SELECT ${selects.join(", ")} FROM "${table}"`,
    )
    cols.forEach((column, i) => {
      const outside = Number(row[`o${i}`] ?? 0)
      if (outside > 0) {
        violations.push({ table, column, outside, min: row[`mn${i}`] as string | null, max: row[`mx${i}`] as string | null })
      }
    })
  }
  return violations
}

export function describeViolations(v: DateViolation[]): string {
  return v.map((x) => `${x.table}.${x.column}: ${x.outside} value(s) outside, ${x.min} … ${x.max}`).join("\n")
}

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const value = i === -1 ? undefined : process.argv[i + 1]
  if (!value) throw new Error("usage: check-dates.ts --start <ISO date> --end <ISO date>")
  return value
}

async function main(): Promise<void> {
  const start = new Date(arg("start"))
  const end = new Date(arg("end"))
  const violations = await checkDates(start, end)
  if (violations.length > 0) {
    log(`check-dates FAILED:\n${describeViolations(violations)}`)
    process.exitCode = 1
    return
  }
  log(`check-dates passed: every event timestamp lies in [${start.toISOString()} − 31d, ${end.toISOString()} + 1d]`)
}

if (require.main === module) {
  main()
    .catch((err: unknown) => {
      log(err instanceof Error ? err.stack ?? err.message : String(err))
      process.exitCode = 1
    })
    .finally(() => closeReadDb())
}

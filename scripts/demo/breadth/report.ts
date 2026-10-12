/**
 * The breadth half of the bake report: row counts per module (what each
 * module's list page shows), the people behind the audit trail, and whether
 * every board-pack section has data. Read-only. Returns false when a module's
 * list would be empty.
 */
import { readDb } from "../sim/readonly-db"

type Row = Record<string, string | number | bigint | null>

const out = (line = ""): void => {
  process.stdout.write(`${line}\n`)
}

async function table(title: string, sql: string): Promise<Row[]> {
  const rows = await readDb().$queryRawUnsafe<Row[]>(sql)
  out(`\n## ${title}`)
  for (const r of rows) out(`  ${Object.values(r).map((v) => String(v)).join(" | ")}`)
  if (rows.length === 0) out("  (none)")
  return rows
}

/** Module → the table its list page reads; each must hold at least one row. */
const MODULE_TABLES: ReadonlyArray<readonly [string, string]> = [
  ["CRM leads", "Lead"], ["CRM activities", "CrmActivity"], ["Agent tasks", "AgentTask"], ["Cross-sell opportunities", "CrossSellOpportunity"],
  ["Contacts", "Contact"], ["Conversations", "Conversation"], ["Insurers", "Insurer"], ["Insurance products", "InsuranceProduct"],
  ["Rate tables", "InsuranceRateTable"], ["Eligibility rules", "InsuranceEligibilityRule"], ["Quotes", "InsuranceQuote"],
  ["Records of advice", "InsuranceAdviceRecord"], ["Policies", "InsurancePolicy"], ["Claims", "InsuranceClaim"],
  ["Advisor commissions", "AdvisorCommission"], ["Complaints", "Complaint"], ["DSAR", "DataSubjectRequest"], ["Breach log", "BreachLog"],
  ["COI declarations", "CoiDeclaration"], ["Fit and proper", "FitAndProper"], ["TCF outcomes", "TcfOutcome"],
  ["Document access log", "DocumentAccessLog"], ["Bureau submissions", "BureauSubmission"], ["Bureau submission lines", "BureauSubmissionRecord"],
  ["Adverse confirmations", "BureauAdverseConfirmation"], ["Referral agents", "ReferralAgent"], ["Referral codes", "ReferralCode"],
  ["Referral events", "ReferralEvent"], ["Branches", "Branch"],
]

export async function breadthReport(): Promise<boolean> {
  let ok = true
  out("\n## Rows per module table")
  for (const [label, t] of MODULE_TABLES) {
    const [r] = await readDb().$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${t}"`)
    const n = Number(r.n)
    if (n === 0) ok = false
    out(`  ${n === 0 ? "EMPTY" : "ok   "} ${label} (${t}): ${n}`)
  }
  await table("Leads by status / source", `SELECT status, source, count(*) FROM "Lead" GROUP BY 1,2 ORDER BY 1,2`)
  await table("CRM activities by type", `SELECT type, count(*) FROM "CrmActivity" GROUP BY 1 ORDER BY 1`)
  await table("Agent tasks by status", `SELECT status, count(*) FROM "AgentTask" GROUP BY 1 ORDER BY 1`)
  await table("Cross-sell opportunities by status", `SELECT status, count(*) FROM "CrossSellOpportunity" GROUP BY 1 ORDER BY 1`)
  await table("Messages by channel / direction / status", `SELECT channel, direction, status, count(*) FROM "Message" GROUP BY 1,2,3 ORDER BY 1,2,3`)
  await table("Conversations by status", `SELECT status, count(*) FROM "Conversation" GROUP BY 1 ORDER BY 1`)
  await table("Insurance quotes by status", `SELECT status, count(*) FROM "InsuranceQuote" GROUP BY 1 ORDER BY 1`)
  await table("Insurance policies / claims / commissions", `
    SELECT 'policy' AS kind, status::text, count(*) FROM "InsurancePolicy" GROUP BY 2
    UNION ALL SELECT 'claim', status::text, count(*) FROM "InsuranceClaim" GROUP BY 2
    UNION ALL SELECT 'commission', status::text, count(*) FROM "AdvisorCommission" GROUP BY 2 ORDER BY 1,2`)
  await table("Complaints by status / outcome", `SELECT status, coalesce(outcome::text, '-'), category, count(*) FROM "Complaint" GROUP BY 1,2,3 ORDER BY 1,3`)
  await table("DSAR by type / status", `SELECT type, status, count(*) FROM "DataSubjectRequest" GROUP BY 1,2 ORDER BY 1`)
  await table("Breach log", `SELECT status, "affectedClients", "reportedToIC" FROM "BreachLog"`)
  await table("TCF outcomes", `SELECT period, outcome1, outcome2, outcome3, outcome4, outcome5, outcome6 FROM "TcfOutcome" ORDER BY period`)
  await table("Bureau files by kind / mode / status", `SELECT kind, mode, status, count(*), sum("recordCount") AS lines, sum("heldCount") AS held FROM "BureauSubmission" GROUP BY 1,2,3 ORDER BY 1`)
  await table("Adverse confirmations", `SELECT x."statusCode", l.reference, x."noticeDate"::text FROM "BureauAdverseConfirmation" x JOIN "Loan" l ON l.id = x."loanId"`)
  await table("Referral events by type / commission status", `SELECT "eventType", "commissionStatus", coalesce("qualityFlag", '-'), count(*), sum("commissionCents")/100.0 AS rands FROM "ReferralEvent" GROUP BY 1,2,3 ORDER BY 1,2`)
  await table("Staff by role / branch", `SELECT u.role, coalesce(b.code, '-') AS branch, u.name FROM "User" u LEFT JOIN "Branch" b ON b.id = u."branchId" ORDER BY 1, 3`)
  await table("Audit rows by actor", `SELECT coalesce("userEmail", '(system)') AS actor, count(*) FROM "AuditLog" GROUP BY 1 ORDER BY 2 DESC`)
  await table("Applications by assigned officer", `SELECT coalesce(u.name, '-') AS officer, a.status, count(*) FROM "LoanApplication" a LEFT JOIN "User" u ON u.id = a."assignedToId" GROUP BY 1,2 ORDER BY 1,2`)

  out("\n## Board pack sections (data behind each)")
  const [bp] = await readDb().$queryRawUnsafe<Row[]>(`SELECT
    (SELECT count(*) FROM "Loan" WHERE status = 'ACTIVE') AS "1-3 active loans",
    (SELECT count(*) FROM "Loan" WHERE status IN ('ACTIVE','DEFAULTED') AND "daysInArrears" > 0) AS "4-5 loans in arrears",
    (SELECT count(*) FROM "Loan" WHERE status IN ('ACTIVE','DEFAULTED') AND "daysInArrears" >= 30) AS "6 delinquent 30+",
    (SELECT count(*) FROM "InsurancePolicy" WHERE status = 'ACTIVE') AS "7 active policies",
    (SELECT count(*) FROM "LoanCharge") AS "default charges (rows)"`)
  for (const [k, v] of Object.entries(bp)) out(`  ${Number(v) > 0 ? "ok   " : "EMPTY"} ${k}: ${String(v)}`)
  out("  (default charges stay empty: TenantConfig.defaultChargesEnabled has no setting or API that turns it on)")
  return ok
}

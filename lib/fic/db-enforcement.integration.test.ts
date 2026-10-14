/**
 * Behavioural proof of the FIC register enforcement in migration
 * 20261014150000_w4_screening_fic: the STR case lifecycle and outcome CHECK,
 * the append-only STR access log and CTR register, and the one-time RMCP
 * approval. Plain SQL; each statement that needs a loan runs inside a
 * transaction that is rolled back, so the loan's deferred guards never fire.
 *
 *   RUN_SCREENING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/fic/db-enforcement.integration.test.ts
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_SCREENING_IT === "1"
const databaseUrl = process.env.DATABASE_URL
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "").slice(0, 16)

function run(value: string): { ok: boolean; output: string } {
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the FIC integration test")
  const result = spawnSync(
    "psql",
    ["--no-psqlrc", "--dbname", databaseUrl, "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-At", "-c", value],
    { encoding: "utf8" },
  )
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` }
}

function sql(value: string): string {
  const result = run(value)
  if (!result.ok) throw new Error(result.output)
  return result.output.trim()
}

suite("FIC register enforcement in the database", () => {
  const tenantId = `tenant_fic_${token}`
  const clientId = `client_fic_${token}`
  const productId = `product_fic_${token}`
  const grounds = "Cash deposits just under the threshold on three consecutive days."
  const strInsert = (id: string, status = "OPEN") => `
    INSERT INTO "SuspiciousReportCase" ("id", "tenantId", "reference", "kind", "clientId", "grounds", "status", "raisedById", "updatedAt")
    VALUES ('${id}', '${tenantId}', 'STR-${id}', 'SUSPICIOUS_TRANSACTION', '${clientId}', '${grounds}', '${status}', 'u1', now());`
  /** A loan and a cash receipt, inside an open transaction the caller rolls back. */
  const loanAndPayment = (amount: number) => `
    INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "clientId", "productId", "appliedAmount", "appliedTermDays", "updatedAt")
      VALUES ('app_fic_${token}', '${tenantId}', 'APP-FIC-${token}', '${clientId}', '${productId}', 100000, 30, now());
    INSERT INTO "Loan" ("id", "tenantId", "reference", "applicationId", "clientId", "productId", "principal", "totalInterest",
      "initiationFee", "totalRepayable", "outstandingPrincipal", "totalPaid", "status", "startDate", "maturityDate",
      "interestRatePm", "interestModel", "updatedAt")
      VALUES ('loan_fic_${token}', '${tenantId}', 'LN-FIC-${token}', 'app_fic_${token}', '${clientId}', '${productId}',
        100000, 0, 0, 100000, 100000, 0, 'ACTIVE', now(), now() + interval '30 days', 0, 'FLAT', now());
    INSERT INTO "Payment" ("id", "tenantId", "loanId", "amount", "paymentMethod")
      VALUES ('pay_fic_${token}', '${tenantId}', 'loan_fic_${token}', ${amount}, 'CASH');`
  const ctr = (status: string, fiu: string, filedAt: string, note: string) => `
    INSERT INTO "CashThresholdReport" ("id", "tenantId", "paymentId", "amountCents", "status", "fiuReference", "filedAt", "note", "recordedById")
    VALUES ('ctr_${token}', '${tenantId}', 'pay_fic_${token}', 5000000, '${status}', ${fiu}, ${filedAt}, ${note}, 'u1');`

  beforeAll(() => {
    sql(`
      INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt") VALUES ('${tenantId}', 'fic-${token}', 'FIC test', now());
      INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "updatedAt")
        VALUES ('${clientId}', '${tenantId}', 'REF-${clientId}', 'ID-${clientId}', 'Synthetic', 'Register', '${clientId}@test.invalid', '+27820000000', now());
      INSERT INTO "LoanProduct" ("id", "tenantId", "code", "name", "productType", "minAmount", "maxAmount", "minTermDays", "maxTermDays", "interestRatePm", "interestModel")
        VALUES ('${productId}', '${tenantId}', 'FIC-${token}', 'FIC product', 'PERSONAL', 1000, 10000000, 30, 90, 0, 'FLAT');
    `)
  })

  it("raises a case OPEN only, with grounds that say something", () => {
    expect(run(strInsert(`str_born_${token}`, "REPORTED")).output).toContain("SuspiciousReportCase_born_open")
    const short = run(strInsert(`str_short_${token}`).replace(grounds, "odd"))
    expect(short.output).toContain("SuspiciousReportCase_outcome_complete")
    expect(run(strInsert(`str_ok_${token}`)).ok).toBe(true)
  })

  it("marks a case REPORTED only with the FIC reference, filing date and assessor; then never changes it", () => {
    const id = `str_rep_${token}`
    sql(strInsert(id))
    expect(run(`UPDATE "SuspiciousReportCase" SET status = 'REPORTED', "assessedById" = 'u1', "assessedAt" = now() WHERE id = '${id}'`).output)
      .toContain("SuspiciousReportCase_outcome_complete")
    sql(`UPDATE "SuspiciousReportCase" SET status = 'REPORTED', "fiuReference" = 'GOAML-TEST-1', "reportedAt" = now(), "assessedById" = 'u1', "assessedAt" = now() WHERE id = '${id}'`)
    for (const change of [`status = 'CLOSED_NO_REPORT'`, `"fiuReference" = 'GOAML-TEST-2'`, `grounds = '${grounds} Edited later.'`]) {
      expect(run(`UPDATE "SuspiciousReportCase" SET ${change} WHERE id = '${id}'`).output, change).toContain("SuspiciousReportCase_decided_immutable")
    }
  })

  it("never deletes a case, never rewrites what was raised, never steps back", () => {
    const id = `str_rec_${token}`
    sql(strInsert(id))
    expect(run(`DELETE FROM "SuspiciousReportCase" WHERE id = '${id}'`).output).toContain("SuspiciousReportCase_no_delete")
    expect(run(`UPDATE "SuspiciousReportCase" SET "clientId" = NULL WHERE id = '${id}'`).output).toContain("SuspiciousReportCase_transition")
    sql(`UPDATE "SuspiciousReportCase" SET status = 'UNDER_REVIEW' WHERE id = '${id}'`)
    expect(run(`UPDATE "SuspiciousReportCase" SET status = 'OPEN' WHERE id = '${id}'`).output).toContain("SuspiciousReportCase_transition")
  })

  it("keeps the STR access log append-only", () => {
    sql(`INSERT INTO "SuspiciousReportAccess" ("id", "tenantId", "userId", "action") VALUES ('acc_${token}', '${tenantId}', 'u1', 'VIEW_REGISTER')`)
    expect(run(`UPDATE "SuspiciousReportAccess" SET action = 'NOTHING' WHERE id = 'acc_${token}'`).output).toContain("SuspiciousReportAccess_append_only")
    expect(run(`DELETE FROM "SuspiciousReportAccess" WHERE id = 'acc_${token}'`).output).toContain("SuspiciousReportAccess_append_only")
  })

  it("records a CTR outcome completely, once, and never edits or deletes it", () => {
    const tx = (body: string) => `BEGIN; ${loanAndPayment(5_000_000)} ${body} ROLLBACK;`
    expect(run(tx(ctr("FILED", "NULL", "now()", "NULL"))).output).toContain("CashThresholdReport_outcome_complete")
    expect(run(tx(ctr("NOT_REPORTABLE", "NULL", "NULL", "'too short'"))).output).toContain("CashThresholdReport_outcome_complete")
    const filed = ctr("FILED", "'GOAML-CTR-1'", "now()", "NULL")
    expect(run(tx(filed)).ok).toBe(true)
    expect(run(tx(filed + filed.replace(`'ctr_${token}'`, `'ctr2_${token}'`))).output).toContain("CashThresholdReport_tenantId_paymentId_key")
    expect(run(tx(`${filed} UPDATE "CashThresholdReport" SET "fiuReference" = 'X' WHERE id = 'ctr_${token}';`)).output).toContain("CashThresholdReport_append_only")
    expect(run(tx(`${filed} DELETE FROM "CashThresholdReport" WHERE id = 'ctr_${token}';`)).output).toContain("CashThresholdReport_append_only")
  })

  it("approves an RMCP version once and never changes its file", () => {
    const id = `rmcp_${token}`
    sql(`INSERT INTO "RmcpDocument" ("id", "tenantId", "version", "title", "fileName", "mimeType", "storagePath", "sha256", "fileSize", "uploadedById", "reviewDueAt")
      VALUES ('${id}', '${tenantId}', 1, 'RMCP', 'rmcp.pdf', 'application/pdf', '/tmp/none.pdf', '${"a".repeat(64)}', 10, 'u1', '2027-10-14')`)
    expect(run(`UPDATE "RmcpDocument" SET "approvedById" = 'u1' WHERE id = '${id}'`).output).toContain("RmcpDocument_approval_complete")
    expect(run(`UPDATE "RmcpDocument" SET sha256 = '${"b".repeat(64)}' WHERE id = '${id}'`).output).toContain("RmcpDocument_transition")
    sql(`UPDATE "RmcpDocument" SET "approvedById" = 'u1', "approvedAt" = now() WHERE id = '${id}'`)
    expect(run(`UPDATE "RmcpDocument" SET "approvedById" = 'u2', "approvedAt" = now() WHERE id = '${id}'`).output).toContain("RmcpDocument_transition")
    expect(run(`DELETE FROM "RmcpDocument" WHERE id = '${id}'`).output).toContain("RmcpDocument_no_delete")
  })
})

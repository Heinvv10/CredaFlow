/**
 * Real-Postgres proof that a decided entity application stays decided, so its
 * frozen regime stays frozen (20261013090000_asset_finance_foundation):
 *   - once it leaves DRAFT / SUBMITTED / UNDER_REVIEW an entity application
 *     never re-enters them, directly or through DECLINED / CANCELLED; once
 *     DISBURSED with a loan its status never changes
 *     (guardEntityApplicationStatus); a consumer application is untouched;
 *   - at commit, a loan carries its application's regime, and a NON_NCA loan
 *     sits beside a DISBURSED NON_NCA application of the same entity at a
 *     principal its classification allows (assertDisbursedCreditLifeCoverage,
 *     the deferred commit invariant).
 *
 *   RUN_ASSET_FINANCE_FOUNDATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/entity-status.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { NCA_LARGE_AGREEMENT_THRESHOLD_CENTS } from "./nca-thresholds"
import { afSqlFixture, expectRejected, idOf, sql } from "./af-sql.integration-fixture"

const RUN = process.env.RUN_ASSET_FINANCE_FOUNDATION_IT === "1"
const suite = RUN ? describe : describe.skip

suite("asset finance foundation: entity application status and the NON_NCA loan at commit", () => {
  const f = afSqlFixture("afs")
  const { entityId } = f.ids
  const setStatus = (id: string, status: string) => `UPDATE "LoanApplication" SET "status" = '${status}' WHERE "id" = '${id}'`
  const status = (id: string) => sql(`SELECT "status" FROM "LoanApplication" WHERE "id" = '${id}'`)
  const REOPEN = "A decided entity application cannot be reopened"
  const DISBURSED_FIXED = "A disbursed entity application with a loan cannot change status"
  const AT_COMMIT = "A NON_NCA loan commits only with its application DISBURSED"

  beforeAll(() => f.seed())
  afterAll(() => f.cleanup())

  it("never reopens an approved entity application, directly or through DECLINED, so its regime stays frozen", () => {
    const id = f.nonNcaApplication()
    sql(f.approveApplication(id))
    for (const open of ["DRAFT", "SUBMITTED", "UNDER_REVIEW"]) expectRejected(setStatus(id, open), REOPEN)
    sql(setStatus(id, "DECLINED"))
    for (const open of ["DRAFT", "SUBMITTED", "UNDER_REVIEW"]) expectRejected(setStatus(id, open), REOPEN)
    expect(status(id)).toBe("DECLINED")
    expectRejected(`UPDATE "LoanApplication" SET "ncaRegime" = 'NCA' WHERE "id" = '${id}'`, "frozen once it is decided")
  })

  it("never reopens a cancelled entity application", () => {
    const app = f.application({ entityId }, "NCA")
    sql(`${app}; ${setStatus(idOf(app), "CANCELLED")}`)
    expectRejected(setStatus(idOf(app), "SUBMITTED"), REOPEN)
  })

  it("never changes a disbursed entity application's status once its loan exists", () => {
    const id = f.nonNcaApplication()
    sql(f.approveApplication(id))
    sql(`${f.loan(id, { entityId }, "NON_NCA")}; ${f.disburse(id)}`)
    for (const next of ["APPROVED", "CANCELLED", "DECLINED", "UNDER_REVIEW", "DRAFT"]) {
      expectRejected(setStatus(id, next), DISBURSED_FIXED)
    }
    expect(status(id)).toBe("DISBURSED")
  })

  it("leaves a consumer application's status transitions as they were", () => {
    const app = f.application({ clientId: f.freshClient() }, null)
    sql(app)
    sql(setStatus(idOf(app), "DECLINED"))
    sql(setStatus(idOf(app), "UNDER_REVIEW"))
    expect(status(idOf(app))).toBe("UNDER_REVIEW")
  })

  it("refuses, at commit, a regime change on an application that already has a loan", () => {
    // An open entity application may carry an NCA loan (fixtures book these);
    // taking the application NON_NCA would leave the loan on the other regime.
    const app = f.application({ entityId }, "NCA")
    sql(`${app}; ${f.loan(idOf(app), { entityId }, "NCA")}`)
    expectRejected(f.toNonNca(idOf(app)), "A loan's NCA regime must be its application's at commit")
    expect(sql(`SELECT "ncaRegime" FROM "LoanApplication" WHERE "id" = '${idOf(app)}'`)).toBe("NCA")
  })

  it("refuses, at commit, a NON_NCA large agreement whose principal drops below R250 000 after booking", () => {
    const large = f.nonNcaApplication(entityId, "LARGE_AGREEMENT", 30_000_000)
    sql(f.approveApplication(large))
    const booked = f.loan(large, { entityId }, "NON_NCA", 30_000_000)
    sql(`${booked}; ${f.disburse(large)}`)
    const below = NCA_LARGE_AGREEMENT_THRESHOLD_CENTS - 1
    expectRejected(
      `UPDATE "Loan" SET "principal" = ${below}, "outstandingPrincipal" = ${below}, "totalRepayable" = ${below + 1}
       WHERE "id" = '${idOf(booked)}'`,
      AT_COMMIT,
    )
    expect(sql(`SELECT "principal" FROM "Loan" WHERE "id" = '${idOf(booked)}'`)).toBe("30000000")
  })
})

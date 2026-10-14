/**
 * Real-Postgres proof that a decided entity application stays decided, so its
 * frozen regime stays frozen (20261013090000_asset_finance_foundation):
 *   - once it leaves DRAFT / SUBMITTED / UNDER_REVIEW an entity application
 *     never re-enters them, directly or through DECLINED / CANCELLED; once
 *     DISBURSED its status never changes, loan or no loan
 *     (guardEntityApplicationStatus, which reads the row before and after the
 *     write); a consumer application is untouched;
 *   - an entity loan is never deleted or truncated (Loan_refuse_entity_delete,
 *     _truncate), so it cannot be re-booked on other terms;
 *   - a decided application's borrower never changes, consumer included
 *     (guardLoanApplicationNcaRegime);
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
  const DISBURSED_FIXED = "A disbursed entity application cannot change status"
  const NO_DELETE = "An entity loan is never deleted"
  const BORROWER_FIXED = "A decided application's borrower cannot change"
  const AT_COMMIT = "A NON_NCA loan commits only with its application DISBURSED"

  beforeAll(() => f.seed())
  afterAll(() => f.cleanup())

  it("never reopens an approved entity application, directly or through CANCELLED, so its regime stays frozen", () => {
    const id = f.nonNcaApplication()
    sql(f.approveApplication(id))
    for (const open of ["DRAFT", "SUBMITTED", "UNDER_REVIEW"]) expectRejected(setStatus(id, open), REOPEN)
    // An approved deal that falls through is CANCELLED, never DECLINED.
    expectRejected(setStatus(id, "DECLINED"), "cannot move from APPROVED to DECLINED")
    sql(setStatus(id, "CANCELLED"))
    for (const open of ["DRAFT", "SUBMITTED", "UNDER_REVIEW"]) expectRejected(setStatus(id, open), REOPEN)
    expect(status(id)).toBe("CANCELLED")
    expectRejected(`UPDATE "LoanApplication" SET "ncaRegime" = 'NCA' WHERE "id" = '${id}'`, "frozen once it is decided")
  })

  it("never moves a declined or cancelled entity application forward, and disburses only after approval", () => {
    const declined = f.nonNcaApplication()
    sql(setStatus(declined, "DECLINED"))
    for (const next of ["APPROVED", "DISBURSED", "CANCELLED"]) expectRejected(setStatus(declined, next), "cannot move from DECLINED")
    const cancelled = f.application({ entityId }, "NCA")
    sql(`${cancelled}; ${setStatus(idOf(cancelled), "CANCELLED")}`)
    expectRejected(
      `UPDATE "LoanApplication" SET "status" = 'APPROVED', "approvedAt" = CURRENT_TIMESTAMP, "approvedById" = '${f.ids.userId}' WHERE "id" = '${idOf(cancelled)}'`,
      "cannot move from CANCELLED",
    )
    const open = f.nonNcaApplication()
    expectRejected(setStatus(open, "DISBURSED"), "cannot move from")
    expect(status(open)).not.toBe("DISBURSED")
  })

  it("never reopens a cancelled entity application", () => {
    const app = f.application({ entityId }, "NCA")
    sql(`${app}; ${setStatus(idOf(app), "CANCELLED")}`)
    expectRejected(setStatus(idOf(app), "SUBMITTED"), REOPEN)
  })

  it("never changes a disbursed entity application's status", () => {
    const id = f.nonNcaApplication()
    sql(f.approveApplication(id))
    sql(`${f.loan(id, { entityId }, "NON_NCA")}; ${f.disburse(id)}`)
    for (const next of ["APPROVED", "CANCELLED", "DECLINED", "UNDER_REVIEW", "DRAFT"]) {
      expectRejected(setStatus(id, next), DISBURSED_FIXED)
    }
    expect(status(id)).toBe("DISBURSED")
  })

  it("never deletes an entity loan, so it cannot be re-booked on other terms", () => {
    const open = f.application({ entityId }, "NCA")
    const openLoan = f.loan(idOf(open), { entityId }, "NCA")
    sql(`${open}; ${openLoan}`)
    expectRejected(`DELETE FROM "Loan" WHERE "id" = '${idOf(openLoan)}'`, NO_DELETE)

    const id = f.nonNcaApplication()
    sql(f.approveApplication(id))
    const booked = f.loan(id, { entityId }, "NON_NCA")
    sql(`${booked}; ${f.disburse(id)}`)
    // Delete, step back to APPROVED, re-book as a FINANCE_LEASE, disburse.
    const rebooked = f.loan(id, { entityId }, "NON_NCA").replace("'INSTALMENT_SALE'", "'FINANCE_LEASE'")
    expectRejected(`BEGIN; DELETE FROM "Loan" WHERE "id" = '${idOf(booked)}'; ${setStatus(id, "APPROVED")};
      ${rebooked}; ${f.disburse(id)}; COMMIT;`, NO_DELETE)
    expect(sql(`SELECT "contractType" FROM "Loan" WHERE "applicationId" = '${id}'`)).toBe("INSTALMENT_SALE")
    // Rolled back either way, so a missing guard cannot empty the shared table.
    expectRejected(`BEGIN; TRUNCATE "Loan" CASCADE; ROLLBACK;`, `${NO_DELETE} (TRUNCATE refused)`)
  })

  it("never moves a disbursed entity application off DISBURSED, even with its loan gone", () => {
    const id = f.nonNcaApplication()
    sql(f.approveApplication(id))
    const booked = f.loan(id, { entityId }, "NON_NCA")
    sql(`${booked}; ${f.disburse(id)}`)
    // The delete guard would refuse first: switch it off inside a rolled-back
    // transaction so the status rule is what is proven.
    expectRejected(`BEGIN;
      ALTER TABLE "Loan" DISABLE TRIGGER "Loan_refuse_entity_delete";
      DELETE FROM "Loan" WHERE "id" = '${idOf(booked)}';
      ${setStatus(id, "APPROVED")};
      ROLLBACK;`, DISBURSED_FIXED)
  })

  it("never changes a decided application's borrower, entity or consumer, so it cannot be reopened as the other", () => {
    const entityApp = f.application({ entityId }, null)
    sql(`${entityApp}; ${setStatus(idOf(entityApp), "DECLINED")}`)
    const consumer = f.freshClient()
    expectRejected(
      `UPDATE "LoanApplication" SET "entityId" = NULL, "clientId" = '${consumer}' WHERE "id" = '${idOf(entityApp)}'`,
      BORROWER_FIXED,
    )
    const consumerApp = f.application({ clientId: f.freshClient() }, null)
    sql(`${consumerApp}; ${setStatus(idOf(consumerApp), "DECLINED")}`)
    expectRejected(
      `UPDATE "LoanApplication" SET "clientId" = NULL, "entityId" = '${entityId}' WHERE "id" = '${idOf(consumerApp)}'`,
      BORROWER_FIXED,
    )
    // Nor in the write that decides it.
    const open = f.application({ entityId }, null)
    sql(open)
    expectRejected(
      `UPDATE "LoanApplication" SET "status" = 'DECLINED', "entityId" = NULL, "clientId" = '${consumer}' WHERE "id" = '${idOf(open)}'`,
      BORROWER_FIXED,
    )
    // An open, unclassified application's borrower may still change.
    sql(`UPDATE "LoanApplication" SET "entityId" = NULL, "clientId" = '${consumer}' WHERE "id" = '${idOf(open)}'`)
  })

  it("treats an application as an entity one when the row before or after the write names an entity", () => {
    const entityApp = f.application({ entityId }, null)
    sql(`${entityApp}; ${setStatus(idOf(entityApp), "DECLINED")}`)
    expectRejected(`UPDATE "LoanApplication" SET "status" = 'UNDER_REVIEW', "entityId" = NULL,
      "clientId" = '${f.freshClient()}' WHERE "id" = '${idOf(entityApp)}'`, REOPEN)
    const consumerApp = f.application({ clientId: f.freshClient() }, null)
    sql(`${consumerApp}; ${setStatus(idOf(consumerApp), "DECLINED")}`)
    expectRejected(`UPDATE "LoanApplication" SET "status" = 'UNDER_REVIEW', "clientId" = NULL,
      "entityId" = '${entityId}' WHERE "id" = '${idOf(consumerApp)}'`, REOPEN)
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

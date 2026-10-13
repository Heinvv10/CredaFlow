/**
 * Real-Postgres proof of the loan booking rules for the NCA regime
 * (20261013090000_asset_finance_foundation):
 *   - a loan carries its application's tenant, borrower and regime, fixed at
 *     booking with its contract type (trigger guardLoanBorrowerRegime);
 *   - a NON_NCA loan is booked only on an approved application, and a NON_NCA
 *     large agreement only for a principal of at least R250 000;
 *   - a collection fee is charged only on a NON_NCA loan
 *     (guardLoanChargeCollectionFee).
 *
 *   RUN_ASSET_FINANCE_FOUNDATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/loan-regime.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { NCA_LARGE_AGREEMENT_THRESHOLD_CENTS } from "./nca-thresholds"
import { afSqlFixture, expectRejected, idOf, sql } from "./af-sql.integration-fixture"

const RUN = process.env.RUN_ASSET_FINANCE_FOUNDATION_IT === "1"
const suite = RUN ? describe : describe.skip

suite("asset finance foundation: loan booking by NCA regime", () => {
  const f = afSqlFixture("afl")
  const { tenantId, entityId, otherEntityId } = f.ids
  const BOUND = "must carry its application's tenant, borrower and NCA regime"

  /** Book a loan on an approved application and disburse it in one transaction (they commit together). */
  const bookAndDisburse = (loanStatement: string, applicationId: string) => `${loanStatement}; ${f.disburse(applicationId)}`

  beforeAll(() => f.seed())
  afterAll(() => f.cleanup())

  it("binds a loan to its application's borrower and regime, and fixes them", () => {
    const consumerApp = f.application({ clientId: f.freshClient() }, null)
    sql(consumerApp)
    expectRejected(f.loan(idOf(consumerApp), { entityId }, "NCA"), BOUND)
    const id = f.nonNcaApplication()
    sql(f.approveApplication(id))
    expectRejected(f.loan(id, { entityId }, "NCA"), BOUND)
    const ok = f.loan(id, { entityId }, "NON_NCA")
    sql(bookAndDisburse(ok, id))
    expect(sql(`SELECT "ncaRegime" FROM "Loan" WHERE "id" = '${idOf(ok)}'`)).toBe("NON_NCA")
    expectRejected(`UPDATE "Loan" SET "ncaRegime" = 'NCA' WHERE "id" = '${idOf(ok)}'`, "fixed at booking")
    expectRejected(`UPDATE "Loan" SET "entityId" = '${otherEntityId}' WHERE "id" = '${idOf(ok)}'`, "fixed at booking")
  })

  it("fixes a loan's contract type at booking, NON_NCA and NCA alike", () => {
    const id = f.nonNcaApplication()
    sql(f.approveApplication(id))
    const nonNca = f.loan(id, { entityId }, "NON_NCA")
    sql(bookAndDisburse(nonNca, id))
    const consumer = f.freshClient()
    const consumerApp = f.application({ clientId: consumer }, null)
    sql(consumerApp)
    const nca = f.loan(idOf(consumerApp), { clientId: consumer }, "NCA")
    sql(nca)
    for (const [loanId, to] of [[idOf(nonNca), "FINANCE_LEASE"], [idOf(nonNca), "LOAN"], [idOf(nca), "INSTALMENT_SALE"]]) {
      expectRejected(`UPDATE "Loan" SET "contractType" = '${to}' WHERE "id" = '${loanId}'`, "contract type are fixed at booking")
    }
    expect(sql(`SELECT "contractType" FROM "Loan" WHERE "id" = '${idOf(nonNca)}'`)).toBe("INSTALMENT_SALE")
  })

  it("refuses a loan for entity B on entity A's application", () => {
    const nca = f.application({ entityId }, "NCA")
    sql(nca)
    expectRejected(f.loan(idOf(nca), { entityId: otherEntityId }, "NCA"), BOUND)
    const id = f.nonNcaApplication()
    sql(f.approveApplication(id))
    expectRejected(bookAndDisburse(f.loan(id, { entityId: otherEntityId }, "NON_NCA"), id), BOUND)
  })

  it("refuses a NON_NCA loan while the application is still open (its regime not yet frozen)", () => {
    const id = f.nonNcaApplication()
    expectRejected(f.loan(id, { entityId }, "NON_NCA"), "A NON_NCA loan requires an approved application")
    sql(`UPDATE "LoanApplication" SET "status" = 'SUBMITTED' WHERE "id" = '${id}'`)
    expectRejected(f.loan(id, { entityId }, "NON_NCA"), "A NON_NCA loan requires an approved application")
  })

  it("holds a NON_NCA large agreement to the R250 000 threshold, and only a large agreement", () => {
    expect(NCA_LARGE_AGREEMENT_THRESHOLD_CENTS).toBe(25_000_000) // the trigger's literal
    const large = f.nonNcaApplication(entityId, "LARGE_AGREEMENT", 30_000_000)
    sql(f.approveApplication(large))
    expectRejected(
      bookAndDisburse(f.loan(large, { entityId }, "NON_NCA", NCA_LARGE_AGREEMENT_THRESHOLD_CENTS - 1), large),
      "large agreement needs a principal of at least R250 000",
    )
    sql(bookAndDisburse(f.loan(large, { entityId }, "NON_NCA", NCA_LARGE_AGREEMENT_THRESHOLD_CENTS), large))

    // Over the juristic threshold, the principal does not matter.
    const juristic = f.nonNcaApplication(otherEntityId, "JURISTIC_OVER_THRESHOLD", 1_000_000)
    sql(f.approveApplication(juristic))
    sql(bookAndDisburse(f.loan(juristic, { entityId: otherEntityId }, "NON_NCA", 1_000_000), juristic))
  })

  it("charges a collection fee only on a NON_NCA loan", () => {
    const charge = (loanId: string, n: number) => `
      INSERT INTO "LoanCharge" ("id", "tenantId", "loanId", "type", "day", "amount")
      VALUES ('chg_${loanId}_${n}', '${tenantId}', '${loanId}', 'COLLECTION_FEE', CURRENT_DATE, 15000)`
    const consumer = f.freshClient()
    const consumerApp = f.application({ clientId: consumer }, null)
    sql(consumerApp)
    const ncaLoan = f.loan(idOf(consumerApp), { clientId: consumer }, "NCA")
    sql(ncaLoan)
    expectRejected(charge(idOf(ncaLoan), 1), "A collection fee may only be charged on a NON_NCA loan")
    sql(`INSERT INTO "LoanCharge" ("id", "tenantId", "loanId", "type", "day", "amount")
         VALUES ('chg_di_${idOf(ncaLoan)}', '${tenantId}', '${idOf(ncaLoan)}', 'DEFAULT_INTEREST', CURRENT_DATE, 100)`)
    expectRejected(
      `UPDATE "LoanCharge" SET "type" = 'COLLECTION_FEE' WHERE "id" = 'chg_di_${idOf(ncaLoan)}'`,
      "A collection fee may only be charged on a NON_NCA loan",
    )

    const id = f.nonNcaApplication()
    sql(f.approveApplication(id))
    const nonNcaLoan = f.loan(id, { entityId }, "NON_NCA")
    sql(bookAndDisburse(nonNcaLoan, id))
    sql(charge(idOf(nonNcaLoan), 2))
    expect(sql(`SELECT count(*) FROM "LoanCharge" WHERE "loanId" = '${idOf(nonNcaLoan)}' AND "type" = 'COLLECTION_FEE'`)).toBe("1")
  })
})

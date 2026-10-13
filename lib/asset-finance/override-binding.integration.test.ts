/**
 * Real-Postgres proof that an NCA regime override is bound to real people and
 * to the application it was requested on
 * (20261013090000_asset_finance_foundation, DESIGN D5):
 *   - requester and decider are users of the override's tenant (composite FKs
 *     to User), so the four-eyes CHECK compares ids exactly: padding (space,
 *     tab, newline, NBSP), invented ids and other tenants' users all fail;
 *   - four-eyes binds an APPROVAL only: a requester may reject their own
 *     request (the classifier does, when a re-run supersedes it);
 *   - an override is requested only on a classified application, with a
 *     snapshot (borrower, amount, product, rule) that is the application as
 *     it stands, required for a move to NON_NCA and immutable;
 *   - guardLoanApplicationNcaRegime spends an approval only on the application
 *     its snapshot describes, and freezes the classification snapshot while an
 *     approval to NON_NCA is unspent (an approval holds the application's row,
 *     so a concurrent snapshot write waits for it and is refused);
 *   - the override table cannot be truncated.
 *
 *   RUN_ASSET_FINANCE_FOUNDATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/override-binding.integration.test.ts
 */
import { spawn } from "node:child_process"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { afSqlFixture, expectRejected, idOf, sql } from "./af-sql.integration-fixture"

const RUN = process.env.RUN_ASSET_FINANCE_FOUNDATION_IT === "1"
const suite = RUN ? describe : describe.skip

suite("asset finance foundation: override binding to users and to the application", () => {
  const f = afSqlFixture("afb")
  const elsewhere = afSqlFixture("afb2")
  const { tenantId, entityId, productId, userId, approverId, token } = f.ids
  const otherProductId = `${productId}_2`
  const ncaApplication = () => {
    const app = f.application({ entityId }, "NCA")
    sql(app)
    return idOf(app)
  }
  const requested = (applicationId: string) => {
    const override = f.pendingOverride(applicationId)
    sql(override.statement)
    return override.id
  }
  const column = (overrideId: string, name: string) =>
    sql(`SELECT COALESCE("${name}"::TEXT, 'null') FROM "NcaRegimeOverride" WHERE "id" = '${overrideId}'`)
  const regime = (applicationId: string) => sql(`SELECT "ncaRegime" FROM "LoanApplication" WHERE "id" = '${applicationId}'`)
  const flip = (id: string) => `UPDATE "LoanApplication" SET "ncaRegime" = 'NON_NCA' WHERE "id" = '${id}'`
  const NO_MATCH = "approval no longer matches the application"

  beforeAll(() => {
    f.seed()
    elsewhere.seed()
    sql(`INSERT INTO "LoanProduct" ("id", "tenantId", "code", "name", "productType", "minAmount", "maxAmount",
           "minTermDays", "maxTermDays", "interestRatePm", "interestModel")
         VALUES ('${otherProductId}', '${tenantId}', 'afb2-${token}', 'AF test product 2', 'PERSONAL', 100, 1000000000,
           30, 3650, 1.0, 'DAILY_ACCRUAL')`)
  })
  afterAll(() => {
    f.cleanup()
    elsewhere.cleanup()
  })

  it("refuses a decider id that is padded, invented or another tenant's user: it names no user of this tenant", () => {
    const overrideId = requested(ncaApplication())
    const decideAs = (expression: string) =>
      `UPDATE "NcaRegimeOverride" SET "status" = 'APPROVED', "decidedById" = ${expression}, "decidedAt" = CURRENT_TIMESTAMP
       WHERE "id" = '${overrideId}'`
    for (const padded of [
      `' ${userId} '`,
      `E'${userId}\\t'`,
      `E'\\n${userId}'`,
      `'${userId}' || U&'\\00A0'`,
      `'nobody_${token}'`,
      `'${elsewhere.ids.userId}'`,
    ]) {
      expectRejected(decideAs(padded), "NcaRegimeOverride_tenantId_decidedById_fkey")
    }
    expect(column(overrideId, "status")).toBe("PENDING")
    // The requester exactly: the CHECK.
    expectRejected(decideAs(`'${userId}'`), "NcaRegimeOverride_four_eyes")
    sql(decideAs(`'${approverId}'`))
  })

  it("refuses a request in the name of no user, or of another tenant's user", () => {
    const id = ncaApplication()
    for (const requester of [`nobody_${token}`, `${userId}\t`, elsewhere.ids.userId]) {
      expectRejected(
        f.pendingOverride(id).statement.replace(`'${userId}'`, `'${requester}'`),
        "NcaRegimeOverride_tenantId_requestedById_fkey",
      )
    }
  })

  it("refuses a decision with no decider or no decision time, so an approval always has a second person", () => {
    const id = requested(ncaApplication())
    expectRejected(
      `UPDATE "NcaRegimeOverride" SET "status" = 'APPROVED', "decidedById" = NULL, "decidedAt" = CURRENT_TIMESTAMP WHERE "id" = '${id}'`,
      "NcaRegimeOverride_decision_complete",
    )
    expectRejected(
      `UPDATE "NcaRegimeOverride" SET "status" = 'APPROVED', "decidedById" = '${approverId}', "decidedAt" = NULL WHERE "id" = '${id}'`,
      "NcaRegimeOverride_decision_complete",
    )
    expect(column(id, "status")).toBe("PENDING")
  })

  it("lets a requester reject their own request, never approve it", () => {
    const overrideId = requested(ncaApplication())
    sql(`UPDATE "NcaRegimeOverride" SET "status" = 'REJECTED', "decidedById" = '${userId}', "decidedAt" = CURRENT_TIMESTAMP,
           "decisionNote" = 'superseded by re-classification' WHERE "id" = '${overrideId}'`)
    expect(column(overrideId, "decidedById")).toBe(userId)
  })

  it("requests an override only on a classified application", () => {
    const unclassified = f.application({ entityId }, null)
    sql(unclassified)
    expectRejected(f.pendingOverride(idOf(unclassified)).statement, "needs a classified application")
  })

  it("records the application as it stands: whole, required for NON_NCA, and true at insert", () => {
    const id = ncaApplication()
    const insert = (to: "NCA" | "NON_NCA", from: "NCA" | "NON_NCA", snapshot: string) => `
      INSERT INTO "NcaRegimeOverride" ("id", "tenantId", "applicationId", "fromRegime", "toRegime", "reason", "source",
        "requestedById", "approvedEntityId", "approvedAppliedAmount", "approvedProductId", "approvedClassificationRule")
      VALUES ('snap_${token}_${Math.random().toString(36).slice(2, 8)}', '${tenantId}', '${id}', '${from}', '${to}',
        'Audited AFS on file', 'MANUAL', '${userId}', ${snapshot})`
    expectRejected(insert("NON_NCA", "NCA", "NULL, NULL, NULL, NULL"), "NcaRegimeOverride_non_nca_snapshot")
    expectRejected(insert("NCA", "NON_NCA", "NULL, 150000000, NULL, NULL"), "NcaRegimeOverride_non_nca_snapshot")
    for (const wrong of [
      `'${f.ids.otherEntityId}', 150000000, '${productId}', 'FINANCIALS_UNPROVEN'`,
      `'${entityId}', 1, '${productId}', 'FINANCIALS_UNPROVEN'`,
      `'${entityId}', 150000000, '${otherProductId}', 'FINANCIALS_UNPROVEN'`,
      `'${entityId}', 150000000, '${productId}', 'LARGE_AGREEMENT'`,
    ]) {
      expectRejected(insert("NON_NCA", "NCA", wrong), "snapshot must be its application as it stands")
    }
    sql(insert("NON_NCA", "NCA", `'${entityId}', 150000000, '${productId}', 'FINANCIALS_UNPROVEN'`))
  })

  it.each([
    ["amount", `"appliedAmount" = 140000000`, `"appliedAmount" = 150000000`],
    ["product", `"productId" = '${otherProductId}'`, `"productId" = '${productId}'`],
  ])("will not spend an approval once the application's %s changed; restored, it applies", (_label, change, restore) => {
    const id = ncaApplication()
    const overrideId = requested(id)
    sql(f.approve(overrideId))
    sql(`UPDATE "LoanApplication" SET ${change} WHERE "id" = '${id}'`)
    expectRejected(flip(id), NO_MATCH)
    expect(column(overrideId, "appliedAt")).toBe("null")
    expect(regime(id)).toBe("NCA")

    sql(`UPDATE "LoanApplication" SET ${restore} WHERE "id" = '${id}'`)
    sql(flip(id))
    expect(regime(id)).toBe("NON_NCA")
    expect(column(overrideId, "appliedAt")).not.toBe("null")
  })

  it("will not spend an approval whose classification rule the application no longer has", () => {
    const id = ncaApplication()
    const overrideId = requested(id)
    sql(`UPDATE "LoanApplication" SET "ncaClassificationRule" = 'LARGE_AGREEMENT' WHERE "id" = '${id}'`)
    sql(f.approve(overrideId))
    expectRejected(flip(id), NO_MATCH)
    expect(column(overrideId, "appliedAt")).toBe("null")
  })

  const AWAITS = "snapshot is frozen while an approved NON_NCA override awaits it"
  const evidence = (id: string) =>
    sql(`SELECT array_to_string("ncaClassificationEvidenceIds", ',') FROM "LoanApplication" WHERE "id" = '${id}'`)

  it("freezes the classification snapshot while an approved NON_NCA override is unspent, so it applies as approved", () => {
    const id = ncaApplication()
    const overrideId = requested(id)
    // While PENDING the classification may still change (a re-run does).
    sql(`UPDATE "LoanApplication" SET "ncaClassificationEvidenceIds" = ARRAY['afs-approved'] WHERE "id" = '${id}'`)
    sql(f.approve(overrideId))
    for (const set of [
      `"ncaClassificationRule" = 'JURISTIC_OVER_THRESHOLD'`,
      `"ncaClassificationInputs" = '{"principalDebtCents": 1}'::jsonb`,
      `"ncaClassificationEvidenceIds" = ARRAY['afs-swapped']`,
      `"ncaClassifiedAt" = CURRENT_TIMESTAMP + INTERVAL '1 day'`,
      `"ncaClassifiedById" = '${approverId}'`,
    ]) {
      expectRejected(`UPDATE "LoanApplication" SET ${set} WHERE "id" = '${id}'`, AWAITS)
    }
    sql(flip(id))
    expect(regime(id)).toBe("NON_NCA")
    expect(evidence(id)).toBe("afs-approved")
  })

  it("makes a snapshot write wait for a concurrent approval, then refuses it", async () => {
    const id = ncaApplication()
    const overrideId = requested(id)
    const marker = `held_${token}`
    // The approval commits two seconds after it is made, holding its locks.
    const approval = spawn("psql", ["--no-psqlrc", "--dbname", process.env.DATABASE_URL ?? "", "-v", "ON_ERROR_STOP=1", "-At"])
    const approvalExit = new Promise<number | null>((resolve) => approval.on("close", resolve))
    approval.stdin.end(`BEGIN;\n${f.approve(overrideId)};\nSELECT pg_sleep(2) AS ${marker};\nCOMMIT;\n`)
    const sleeping = () => sql(`SELECT count(*) FROM pg_stat_activity
      WHERE state = 'active' AND query LIKE '%AS ${marker}%' AND pid <> pg_backend_pid()`) === "1"
    for (const deadline = Date.now() + 10_000; !sleeping(); ) {
      if (Date.now() > deadline) throw new Error("the approval never reached its sleep")
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expectRejected(`UPDATE "LoanApplication" SET "ncaClassificationEvidenceIds" = ARRAY['afs-swapped'] WHERE "id" = '${id}'`, AWAITS)
    expect(await approvalExit).toBe(0)
    expect(column(overrideId, "status")).toBe("APPROVED")
  }, 20_000)

  it("refuses a REPEATABLE READ snapshot write whose snapshot predates the approval", async () => {
    const id = ncaApplication()
    const overrideId = requested(id)
    const marker = `rr_${token}`
    // The writer takes its snapshot while the request is PENDING, sleeps, then
    // writes after the approval has committed.
    const writer = spawn("psql", ["--no-psqlrc", "--dbname", process.env.DATABASE_URL ?? "", "-v", "ON_ERROR_STOP=1", "-At"])
    let output = ""
    writer.stdout.on("data", (chunk) => { output += String(chunk) })
    writer.stderr.on("data", (chunk) => { output += String(chunk) })
    const writerExit = new Promise<number | null>((resolve) => writer.on("close", resolve))
    writer.stdin.end(`BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT "status" FROM "NcaRegimeOverride" WHERE "id" = '${overrideId}';
SELECT pg_sleep(2) AS ${marker};
UPDATE "LoanApplication" SET "ncaClassificationEvidenceIds" = ARRAY['afs-swapped'] WHERE "id" = '${id}';
COMMIT;
`)
    const sleeping = () => sql(`SELECT count(*) FROM pg_stat_activity
      WHERE state = 'active' AND query LIKE '%AS ${marker}%' AND pid <> pg_backend_pid()`) === "1"
    for (const deadline = Date.now() + 10_000; !sleeping(); ) {
      if (Date.now() > deadline) throw new Error("the writer never reached its sleep")
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    sql(f.approve(overrideId))
    expect(await writerExit).not.toBe(0)
    expect(output).toContain("could not serialize")
    expect(evidence(id)).not.toContain("afs-swapped")
  }, 20_000)

  it("never rewrites the snapshot or source of a request", () => {
    const overrideId = requested(ncaApplication())
    const where = `WHERE "id" = '${overrideId}'`
    for (const set of [
      `"approvedAppliedAmount" = 1`,
      `"approvedClassificationRule" = 'LARGE_AGREEMENT'`,
      `"approvedProductId" = '${otherProductId}'`,
      `"approvedEntityId" = '${f.ids.otherEntityId}'`,
      `"source" = 'CLASSIFIER'`,
    ]) {
      expectRejected(`UPDATE "NcaRegimeOverride" SET ${set} ${where}`, "override request is immutable")
    }
  })

  it("refuses TRUNCATE of the override table", () => {
    requested(ncaApplication())
    // Rolled back either way, so a missing guard cannot empty the shared table.
    expectRejected(`BEGIN; TRUNCATE "NcaRegimeOverride"; ROLLBACK;`, "never deleted (TRUNCATE refused)")
    expect(Number(sql(`SELECT count(*) FROM "NcaRegimeOverride" WHERE "tenantId" = '${tenantId}'`))).toBeGreaterThan(0)
  })
})

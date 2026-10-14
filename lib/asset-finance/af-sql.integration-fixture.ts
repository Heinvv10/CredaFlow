/**
 * Shared psql fixture for the RUN_ASSET_FINANCE_FOUNDATION_IT suites
 * (borrower-xor, regime-override, loan-regime). Statements run through psql so
 * the database's own error text (constraint names, RAISE messages) is what the
 * suites assert on. Not a test file: it has no suite of its own.
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { expect } from "vitest"

export type Regime = "NCA" | "NON_NCA"
export interface Borrower {
  clientId?: string
  entityId?: string
}

function run(value: string): { ok: boolean; output: string } {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the asset finance foundation integration tests")
  const result = spawnSync(
    "psql",
    ["--no-psqlrc", "--dbname", databaseUrl, "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-At", "-c", value],
    { encoding: "utf8" },
  )
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` }
}

export function sql(value: string): string {
  const result = run(value)
  if (!result.ok) throw new Error(result.output)
  return result.output.trim()
}

export function expectRejected(statement: string, constraintOrMessage: string): void {
  const result = run(statement)
  expect(result.ok).toBe(false)
  expect(result.output).toContain(constraintOrMessage)
}

const quoted = (value: string | undefined) => (value ? `'${value}'` : "NULL")

/** The id in an INSERT built here: the first VALUES literal. */
export function idOf(statement: string): string {
  const match = /VALUES \('([^']+)'/.exec(statement)
  if (!match) throw new Error("no id in statement")
  return match[1]
}

export function afSqlFixture(label: string) {
  const token = randomUUID().replaceAll("-", "").slice(0, 16)
  const tenantId = `tenant_${label}_${token}`
  const ids = {
    token,
    tenantId,
    clientId: `client_${label}_${token}`,
    entityId: `entity_${label}_${token}`,
    otherEntityId: `entity2_${label}_${token}`,
    productId: `product_${label}_${token}`,
    userId: `user_${label}_${token}`,
    approverId: `approver_${label}_${token}`,
  }
  let seq = 0
  const next = () => {
    seq += 1
    return seq
  }

  /** INSERT an application, unclassified (null) or classified NCA with `rule`. */
  function application(borrower: Borrower, regime: Regime | null, rule = "FINANCIALS_UNPROVEN", amount = 150_000_000): string {
    const n = next()
    return `
      INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "clientId", "entityId", "productId",
        "appliedAmount", "appliedTermDays", "ncaRegime", "ncaClassificationRule", "ncaClassifiedAt",
        "ncaClassifiedById", "updatedAt")
      VALUES ('app_${label}_${token}_${n}', '${tenantId}', '${label}-${token}-${n}', ${quoted(borrower.clientId)},
        ${quoted(borrower.entityId)}, '${ids.productId}', ${amount}, 1825,
        ${regime ? `'${regime}', '${rule}', CURRENT_TIMESTAMP, '${ids.userId}'` : "NULL, NULL, NULL, NULL"},
        CURRENT_TIMESTAMP)`
  }

  /**
   * INSERT a PENDING NCA → NON_NCA override requested by the fixture user,
   * its snapshot read from the application as it stands.
   */
  function pendingOverride(applicationId: string): { id: string; statement: string } {
    const id = `ovr_${label}_${token}_${next()}`
    return {
      id,
      statement: `INSERT INTO "NcaRegimeOverride" ("id", "tenantId", "applicationId", "fromRegime", "toRegime", "reason",
          "source", "requestedById", "approvedEntityId", "approvedAppliedAmount", "approvedProductId", "approvedClassificationRule",
          "approvedClassifiedAt")
        SELECT '${id}', '${tenantId}', '${applicationId}', 'NCA', 'NON_NCA', 'Audited AFS on file', 'MANUAL', '${ids.userId}',
          application."entityId", application."appliedAmount", application."productId", application."ncaClassificationRule",
          application."ncaClassifiedAt"
        FROM "LoanApplication" AS application WHERE application."id" = '${applicationId}'`,
    }
  }

  const approve = (overrideId: string) =>
    `UPDATE "NcaRegimeOverride" SET "status" = 'APPROVED', "decidedById" = '${ids.approverId}',
       "decidedAt" = CURRENT_TIMESTAMP WHERE "id" = '${overrideId}'`

  /** SQL taking an NCA application to NON_NCA the only legal way: request, second approver, flip. */
  function toNonNca(applicationId: string): string {
    const override = pendingOverride(applicationId)
    return `${override.statement}; ${approve(override.id)};
      UPDATE "LoanApplication" SET "ncaRegime" = 'NON_NCA' WHERE "id" = '${applicationId}'`
  }

  /** INSERT an entity application, classified NCA, and take it to NON_NCA. Returns its id. */
  function nonNcaApplication(entityId = ids.entityId, rule = "FINANCIALS_UNPROVEN", amount = 150_000_000): string {
    const statement = application({ entityId }, "NCA", rule, amount)
    sql(`${statement}; ${toNonNca(idOf(statement))}`)
    return idOf(statement)
  }

  // An entity application reaches APPROVED through SUBMITTED (guardEntityApplicationStatus).
  const approveApplication = (applicationId: string) =>
    `UPDATE "LoanApplication" SET "status" = 'SUBMITTED' WHERE "id" = '${applicationId}' AND "status" = 'DRAFT';
     UPDATE "LoanApplication" SET "status" = 'APPROVED', "repaymentMethod" = 'EFT', "approvedAt" = CURRENT_TIMESTAMP,
       "approvedById" = '${ids.userId}' WHERE "id" = '${applicationId}'`

  const disburse = (applicationId: string) =>
    `UPDATE "LoanApplication" SET "status" = 'DISBURSED', "disbursedAt" = CURRENT_TIMESTAMP WHERE "id" = '${applicationId}'`

  function loan(applicationId: string, borrower: Borrower, regime: Regime, principal = 150_000_000): string {
    const n = next()
    return `
      INSERT INTO "Loan" ("id", "tenantId", "reference", "applicationId", "clientId", "entityId", "productId",
        "principal", "totalInterest", "initiationFee", "totalRepayable", "outstandingPrincipal",
        "startDate", "maturityDate", "interestRatePm", "interestModel", "ncaRegime", "contractType", "updatedAt")
      VALUES ('loan_${label}_${token}_${n}', '${tenantId}', '${label}L-${token}-${n}', '${applicationId}',
        ${quoted(borrower.clientId)}, ${quoted(borrower.entityId)},
        '${ids.productId}', ${principal}, 1, 0, ${principal + 1}, ${principal}, CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + INTERVAL '5 years', 1.0, 'DAILY_ACCRUAL', '${regime}',
        '${regime === "NON_NCA" ? "INSTALMENT_SALE" : "LOAN"}', CURRENT_TIMESTAMP)`
  }

  /** One open application per client and product: each consumer case gets its own client. */
  function freshClient(): string {
    const n = next()
    const id = `client_${label}_${token}_${n}`
    sql(`INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "updatedAt")
         VALUES ('${id}', '${tenantId}', 'CLI-${token}-${n}', 'ID-${token}-${n}', 'Test', 'Consumer',
         'c-${token}-${n}@test.invalid', '+27820000000', CURRENT_TIMESTAMP)`)
    return id
  }

  function seed(): void {
    sql(`
      INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt") VALUES ('${tenantId}', '${label}-${token}', 'AF test', CURRENT_TIMESTAMP);
      INSERT INTO "User" ("id", "tenantId", "email", "password", "updatedAt")
        VALUES ('${ids.userId}', '${tenantId}', '${label}-${token}@test.invalid', 'x', CURRENT_TIMESTAMP),
               ('${ids.approverId}', '${tenantId}', '${label}-approver-${token}@test.invalid', 'x', CURRENT_TIMESTAMP);
      INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "updatedAt")
        VALUES ('${ids.clientId}', '${tenantId}', 'CLI-${token}', 'ID-${token}', 'Test', 'Director', 'c-${token}@test.invalid', '+27820000000', CURRENT_TIMESTAMP);
      INSERT INTO "LoanProduct" ("id", "tenantId", "code", "name", "productType", "minAmount", "maxAmount",
        "minTermDays", "maxTermDays", "interestRatePm", "interestModel")
        VALUES ('${ids.productId}', '${tenantId}', '${label}-${token}', 'AF test product', 'PERSONAL', 100, 1000000000, 30, 3650, 1.0, 'DAILY_ACCRUAL');
      INSERT INTO "BusinessEntity" ("id", "tenantId", "type", "legalName", "registrationNumber", "updatedAt")
        VALUES ('${ids.entityId}', '${tenantId}', 'COMPANY', 'TEST Plant Hire (Pty) Ltd', '2099/${token.slice(0, 6)}/07', CURRENT_TIMESTAMP),
               ('${ids.otherEntityId}', '${tenantId}', 'COMPANY', 'TEST Earthmoving (Pty) Ltd', '2099/${token.slice(0, 6)}/08', CURRENT_TIMESTAMP);
    `)
  }

  /**
   * Overrides are never deleted (guardNcaRegimeOverrideLifecycle), so this
   * test's own rows go with triggers off for the one transaction.
   */
  function cleanup(): void {
    sql(`
      BEGIN;
      SET LOCAL session_replication_role = replica;
      DELETE FROM "LoanCharge" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "RepaymentSchedule" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "Loan" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "NcaRegimeOverride" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "LoanApplication" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "EntityRelationship" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "BusinessEntity" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "LoanProduct" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "Client" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "User" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "Tenant" WHERE "id" = '${tenantId}';
      COMMIT;
    `)
  }

  return {
    ids, application, pendingOverride, approve, toNonNca, nonNcaApplication, approveApplication, disburse, loan,
    freshClient, seed, cleanup,
  }
}

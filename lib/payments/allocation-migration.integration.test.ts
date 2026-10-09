/**
 * Behavioural proof for Payment.allocationStatus and the
 * assert_payment_allocation_reconciles() ledger check.
 *
 * Run only against a throwaway PostgreSQL database migrated with the baseline:
 *
 *   RUN_PAYMENT_ALLOCATION_MIGRATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/payments/allocation-migration.integration.test.ts
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

const RUN = process.env.RUN_PAYMENT_ALLOCATION_MIGRATION_IT === "1";
const databaseUrl = process.env.DATABASE_URL;
const suite = RUN ? describe : describe.skip;
const token = randomUUID().replaceAll("-", "");

function psqlDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required for the allocation migration test",
    );
  }
  const parsed = new URL(databaseUrl);
  parsed.searchParams.delete("schema");
  return parsed.toString();
}

function psqlArgs(...args: string[]): string[] {
  return [
    "--no-psqlrc",
    "--dbname",
    psqlDatabaseUrl(),
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    ...args,
  ];
}

function sql(value: string): string {
  return execFileSync("psql", psqlArgs("-At", "-c", value), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

suite("payment allocation reconciliation migration", () => {
  const tenantId = `tenant_payment_allocation_${token}`;
  const clientId = `client_payment_allocation_${token}`;
  const ambiguousProductId = `product_ambiguous_${token}`;

  beforeAll(() => {
    sql(`
      INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt")
      VALUES (
        '${tenantId}', 'payment-allocation-${token}',
        'Payment allocation migration test', CURRENT_TIMESTAMP
      );

      INSERT INTO "Client" (
        "id", "tenantId", "reference", "idNumber", "firstName", "lastName",
        "email", "phone", "updatedAt"
      ) VALUES (
        '${clientId}', '${tenantId}', 'CLI-ALLOC-${token}', 'ALLOC-${token}',
        'Synthetic', 'Allocation', 'allocation-${token}@test.invalid',
        '+27820000111', CURRENT_TIMESTAMP
      );

      INSERT INTO "LoanProduct" (
        "id", "tenantId", "code", "name", "productType", "minAmount",
        "maxAmount", "minTermDays", "maxTermDays", "interestRatePm",
        "interestModel"
      ) VALUES (
        '${ambiguousProductId}', '${tenantId}', 'AMB-${token}',
        'Ambiguous migration product', 'PERSONAL', 1000, 1000000,
        30, 365, 0, 'FLAT'
      );
    `);
  });

  it("makes future Payment inserts allocated and non-null by default", () => {
    expect(
      sql(`
      SELECT concat_ws(
        '|', is_nullable, column_default LIKE '%ALLOCATED%'
      )
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'Payment'
        AND column_name = 'allocationStatus';
    `),
    ).toBe("NO|t");
  });

  it("fails closed when an unaudited historical mismatch is ambiguous", () => {
    // The check reports the FIRST mismatched loan by id, database-wide. The
    // mismatch is therefore built and checked inside one transaction that never
    // commits — so no run leaves a mismatch behind for the next one — and the
    // loan id starts with "0" so it sorts ahead of other suites' rows on a
    // shared database (cuids, and every other fixture id, start with a letter).
    const loanId = `0_loan_ambiguous_${token}`;
    const fixture = `
      -- The loan is booked against a still-DRAFT application, as
      -- lib/loan/charges.integration-fixture.ts does: the reconciliation check
      -- reads only Loan and Payment, and approving or disbursing an
      -- application needs PASQ, credit-life and agreement evidence that has
      -- nothing to do with what this test proves.
      INSERT INTO "LoanApplication" (
        "id", "tenantId", "reference", "clientId", "productId",
        "appliedAmount", "appliedTermDays", "updatedAt"
      ) VALUES (
        'app_ambiguous_${token}', '${tenantId}', 'APP-AMB-${token}',
        '${clientId}', '${ambiguousProductId}', 100000, 30,
        CURRENT_TIMESTAMP
      );

      INSERT INTO "Loan" (
        "id", "tenantId", "reference", "applicationId", "clientId",
        "productId", "principal", "totalInterest", "initiationFee",
        "totalRepayable", "outstandingPrincipal", "totalPaid", "status",
        "startDate", "maturityDate", "interestRatePm", "interestModel",
        "updatedAt"
      ) VALUES (
        '${loanId}', '${tenantId}', 'LN-AMB-${token}',
        'app_ambiguous_${token}', '${clientId}', '${ambiguousProductId}',
        100000, 0, 0, 100000, 100000, 0, 'ACTIVE',
        TIMESTAMPTZ '2026-01-01 00:00:00+00',
        TIMESTAMPTZ '2026-02-01 00:00:00+00', 0, 'FLAT',
        CURRENT_TIMESTAMP
      );

      INSERT INTO "Payment" (
        "id", "tenantId", "loanId", "amount", "paymentMethod",
        "reference", "notes"
      ) VALUES (
        'payment_ambiguous_${token}', '${tenantId}',
        '${loanId}', 999, 'EFT', 'AMBIGUOUS',
        'No allocation audit evidence'
      );
    `;

    const rejected = spawnSync(
      "psql",
      psqlArgs(
        "-At",
        "-c",
        `BEGIN; ${fixture} SELECT "assert_payment_allocation_reconciles"(); ROLLBACK;`,
      ),
      { encoding: "utf8" },
    );

    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain(
      "Payment allocation backfill is ambiguous",
    );
    expect(rejected.stderr).toContain(loanId);
    expect(sql(`SELECT count(*) FROM "Loan" WHERE "id" = '${loanId}';`)).toBe("0");
  });
});
